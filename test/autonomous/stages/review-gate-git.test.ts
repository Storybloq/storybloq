/**
 * ISS-1282: the receipt gate against real git, for what a fake probe cannot
 * show: git's own view of a path (attributes, modes, symlinks, submodules) and
 * which files it opens. Each repository is a fresh temporary one; identity and
 * the file protocol are passed per command (`-c`). A test that needs a local
 * setting writes it with `--file` into that temporary repository's own config.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessCodeReceipts, parseNumstatZ } from "../../../src/autonomous/review-gate-receipt.js";
import { itemNumstat, realProbe } from "../../../src/autonomous/stages/review-gate.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();

const ASTRA = { provider: "codex", role: "review", requested: "max", resolved: "gpt-6-astra", observed: "gpt-6-astra", evidence: "runtime_session_record", selection: "requested" };
const NO_RULING = { geminiRulingAccepted: false };
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

const made: string[] = [];
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "iss1282-git-"));
  made.push(d);
  git(d, "init", "-q");
  return d;
}
/** A local setting, written into `d`'s own git directory and nowhere else. */
function setConfig(d: string, key: string, value: string): void {
  git(d, "config", "--file", join(git(d, "rev-parse", "--absolute-git-dir"), "config"), key, value);
}
function commit(d: string, message: string): string {
  git(d, "add", "-A");
  git(d, "commit", "-qm", message);
  return git(d, "rev-parse", "HEAD");
}
/** The gate over `root`'s working tree against `baseline`, with one receipt per range. */
async function gate(root: string, baseline: string, ranges: readonly [string, string, string][]) {
  const receipts = ranges.map(([base, head, receipt]) => ({ cwd: root, base, head, receipt, models: [ASTRA], sessionId: "s1" }));
  return assessCodeReceipts(receipts, { baseline, entries: await itemNumstat(root, baseline) }, realProbe, root, NO_RULING);
}

afterEach(() => {
  for (const d of made.splice(0)) {
    try { chmodSync(join(d, ".story", "locked.json"), 0o600); } catch { /* not every repo has one */ }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("ISS-1282 receipt gate on real git", () => {
  it("counts text an attribute calls binary, so an oversized range cannot pass as ~0 changed lines", async () => {
    const d = repo();
    writeFileSync(join(d, "big.txt"), "");
    writeFileSync(join(d, "real.bin"), Buffer.from([1, 0, 2]));
    const c0 = commit(d, "base");
    writeFileSync(join(d, "big.txt"), lines(400));
    writeFileSync(join(d, "real.bin"), Buffer.from([3, 0, 4]));
    const c1 = commit(d, "change");
    mkdirSync(join(d, ".git", "info"), { recursive: true });
    writeFileSync(join(d, ".git", "info", "attributes"), "big.txt binary\n");
    // The attribute took effect: git's plain numstat hides the text. Git
    // 2.54.0 (Apple Git-157) hides it under `--text` too, so the gate counts
    // the two blobs itself, outside the repository.
    expect(git(d, "diff", "--numstat", c0, c1, "--", "big.txt")).toMatch(/^-\t-\tbig\.txt$/);
    expect(git(d, "diff", "--numstat", "--text", c0, c1, "--", "big.txt")).toMatch(/^-\t-\tbig\.txt$/);

    expect(parseNumstatZ(await realProbe.numstat(d, c0, c1))).toEqual([
      { path: "big.txt", added: 400, deleted: 0 },
      { path: "real.bin", added: null, deleted: null },
    ]);
    // The working tree is counted the same way, from the baseline blob and the file on disk.
    expect(await itemNumstat(d, c0)).toEqual([
      { path: "big.txt", added: 400, deleted: 0 },
      { path: "real.bin", added: null, deleted: null },
    ]);
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: [range] (~0 changed lines)"]]))
      .toEqual({ ok: false, reason: `reviewReceipts[0] range ${c0}..${c1} is 400 changed lines; split it to at most 300` });
  });

  it("an attribute over a genuinely binary file keeps the binary exemption: content decides, not the attribute", async () => {
    const d = repo();
    const blob = (fill: number): Buffer => {
      const b = Buffer.from(lines(400));
      b[100] = 0;
      b[0] = fill;
      return b;
    };
    writeFileSync(join(d, "data.txt"), blob(0x61));
    const c0 = commit(d, "base");
    writeFileSync(join(d, "data.txt"), blob(0x62));
    const c1 = commit(d, "change");
    mkdirSync(join(d, ".git", "info"), { recursive: true });
    writeFileSync(join(d, ".git", "info", "attributes"), "data.txt binary\n");

    expect(parseNumstatZ(await realProbe.numstat(d, c0, c1))).toEqual([{ path: "data.txt", added: null, deleted: null }]);
    expect(await itemNumstat(d, c0)).toEqual([{ path: "data.txt", added: null, deleted: null }]);
  });

  describe("a type change counts each side once, with or without an attribute", () => {
    /**
     * Git's own count of `path` over c0..c1, the gate's before any attribute,
     * and the gate's with `path binary` set. `before` must equal `range`: the
     * count never depends on an attribute.
     */
    async function underAttribute(d: string, c0: string, c1: string, path: string) {
      const plainGit = parseNumstatZ(git(d, "diff", "--numstat", "-z", "--no-renames", c0, c1, "--", path));
      const only0 = (entries: readonly { path: string }[] | null) => entries?.filter((e) => e.path === path);
      const before = { range: only0(parseNumstatZ(await realProbe.numstat(d, c0, c1))), item: only0(await itemNumstat(d, c0)) };
      mkdirSync(join(d, ".git", "info"), { recursive: true });
      writeFileSync(join(d, ".git", "info", "attributes"), `${path} binary\n`);
      expect(git(d, "diff", "--numstat", c0, c1, "--", path)).toMatch(/^-\t-\t/);
      // Only `path`: a submodule change also touches .gitmodules, which carries no attribute.
      const only = (entries: readonly { path: string }[] | null) => entries?.filter((e) => e.path === path);
      const got = { plainGit, range: only(parseNumstatZ(await realProbe.numstat(d, c0, c1))), item: only(await itemNumstat(d, c0)) };
      expect(before).toEqual({ range: got.range, item: got.item });
      return got;
    }

    it("a symlink whose link text equals the file that replaces it is removed and added, not 0/0", async () => {
      const d = repo();
      const text = Array.from({ length: 100 }, () => "x").join("\n");
      symlinkSync(text, join(d, "link"));
      const c0 = commit(d, "a symlink");
      unlinkSync(join(d, "link"));
      writeFileSync(join(d, "link"), text);
      const c1 = commit(d, "a file with the same bytes");
      const got = await underAttribute(d, c0, c1, "link");
      // Git 2.54.0 (Apple Git-157) diffs the two sides as one blob pair: equal bytes, 0/0.
      expect(got.plainGit).toEqual([{ path: "link", added: 0, deleted: 0 }]);
      expect(got.range).toEqual([{ path: "link", added: 100, deleted: 100 }]);
      expect(got.item).toEqual(got.range);
    });

    it("a file replaced by a submodule counts the file removed and the commit line added", async () => {
      const lib = repo();
      writeFileSync(join(lib, "x"), "1\n");
      commit(lib, "lib 1");
      const d = repo();
      writeFileSync(join(d, "sub"), lines(50));
      const c0 = commit(d, "a file");
      git(d, "rm", "-q", "sub");
      git(d, "submodule", "add", "-q", lib, "sub");
      const c1 = commit(d, "a submodule in its place");
      const got = await underAttribute(d, c0, c1, "sub");
      expect(got.plainGit).toEqual([{ path: "sub", added: 1, deleted: 50 }]);
      expect(got.range).toEqual(got.plainGit);
      expect(got.item).toEqual(got.plainGit);
    });

    it("a submodule replaced by a file counts the commit line removed and the file added", async () => {
      const lib = repo();
      writeFileSync(join(lib, "x"), "1\n");
      commit(lib, "lib 1");
      const d = repo();
      git(d, "submodule", "add", "-q", lib, "sub");
      const c0 = commit(d, "a submodule");
      git(d, "rm", "-q", "sub");
      writeFileSync(join(d, "sub"), lines(50));
      const c1 = commit(d, "a file in its place");
      const got = await underAttribute(d, c0, c1, "sub");
      expect(got.plainGit).toEqual([{ path: "sub", added: 50, deleted: 1 }]);
      expect(got.range).toEqual(got.plainGit);
      expect(got.item).toEqual(got.plainGit);
    });
  });

  it("a mode is part of the chain: a review that ends executable does not cover a working tree that is not", async () => {
    const d = repo();
    writeFileSync(join(d, "run.sh"), "x\n");
    chmodSync(join(d, "run.sh"), 0o644);
    const c0 = commit(d, "base");
    writeFileSync(join(d, "run.sh"), "y\n");
    chmodSync(join(d, "run.sh"), 0o755);
    const c1 = commit(d, "change and chmod +x");
    expect((await gate(d, c0, [[c0, c1, "REVIEWED: run.sh (~2 changed lines)"]])).ok).toBe(true);

    chmodSync(join(d, "run.sh"), 0o644);
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: run.sh (~2 changed lines)"]]))
      .toEqual({ ok: false, reason: "stale review: the last review of run.sh does not end where the working tree is" });
  });

  it("a symlink is not the file its target text would be", async () => {
    const d = repo();
    writeFileSync(join(d, "link"), "W");
    const c0 = commit(d, "base");
    writeFileSync(join(d, "link"), "target.txt");
    const c1 = commit(d, "regular file holding the target text");
    unlinkSync(join(d, "link"));
    symlinkSync("target.txt", join(d, "link"));
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: link (~2 changed lines)"]]))
      .toEqual({ ok: false, reason: "stale review: the last review of link does not end where the working tree is" });
  });

  it("a submodule is its checked-out commit, and uncommitted content in it refuses by name", async () => {
    const lib = repo();
    writeFileSync(join(lib, "lib.ts"), "a\n");
    commit(lib, "lib 1");
    const d = repo();
    git(d, "submodule", "add", "-q", lib, "sub");
    const c0 = commit(d, "add submodule");
    const sub = join(d, "sub");
    writeFileSync(join(sub, "lib.ts"), "b\n");
    commit(sub, "lib 2");
    const c1 = commit(d, "bump submodule");
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: sub (~2 changed lines)"]])).toMatchObject({ ok: true });

    writeFileSync(join(sub, "lib.ts"), "c\n");
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: sub (~2 changed lines)"]])).toEqual({
      ok: false,
      reason: "could not compare sub with the reviewed commits: submodule sub has uncommitted changes, which no reviewed commit holds: commit them in the submodule and review the commit that records it",
    });
  });

  it("an unreadable tracked ledger file is never opened, so it cannot reject the item diff", async () => {
    const d = repo();
    mkdirSync(join(d, ".story"));
    writeFileSync(join(d, ".story", "locked.json"), "{}\n");
    writeFileSync(join(d, "a.ts"), "a\n");
    const c0 = commit(d, "base");
    writeFileSync(join(d, ".story", "locked.json"), "{\"changed\":true}\n");
    chmodSync(join(d, ".story", "locked.json"), 0o000);
    writeFileSync(join(d, "a.ts"), "b\n");
    expect(await itemNumstat(d, c0)).toEqual([{ path: "a.ts", added: 1, deleted: 1 }]);
  });

  it("a text change routed through a binary commit cannot pass as ~0-line chunks", async () => {
    const d = repo();
    writeFileSync(join(d, "big.txt"), "");
    const c0 = commit(d, "base");
    writeFileSync(join(d, "big.txt"), Buffer.from([0]));
    const c1 = commit(d, "a NUL blob in between");
    writeFileSync(join(d, "big.txt"), lines(400));
    const c2 = commit(d, "400 lines of text");
    expect(await itemNumstat(d, c0)).toEqual([{ path: "big.txt", added: 400, deleted: 0 }]);
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: big.txt (~0 changed lines)"], [c1, c2, "REVIEWED: big.txt (~0 changed lines)"]])).toEqual({
      ok: false,
      reason: `reviewReceipts[0] range ${c0}..${c1} counts big.txt as binary, but the item's own diff of it is text: review it in ranges that hold it as text`,
    });
  });

  it("an untracked file git calls text is text, whatever NUL follows its first 8000 bytes", async () => {
    const d = repo();
    writeFileSync(join(d, "a.ts"), "a\n");
    const c0 = commit(d, "base");
    // Over 8000 bytes of text, then a NUL: git reads it as text, ~1000 lines.
    const late = Buffer.concat([Buffer.from(lines(1000)), Buffer.from([0, 10])]);
    expect(late.indexOf(0)).toBeGreaterThanOrEqual(8000);
    writeFileSync(join(d, "late.txt"), Buffer.from([0, 120]));
    const c1 = commit(d, "an early-NUL blob in between");
    writeFileSync(join(d, "late.txt"), late);
    const c2 = commit(d, "the final content");
    // The same content, untracked, on the baseline.
    git(d, "checkout", "-q", "--detach", c0);
    writeFileSync(join(d, "late.txt"), late);
    expect(git(d, "status", "--porcelain")).toBe("?? late.txt");
    expect((await itemNumstat(d, c0)).find((e) => e.path === "late.txt")?.added).toBeGreaterThan(300);
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: late.txt (~0 changed lines)"], [c1, c2, "REVIEWED: late.txt (~0 changed lines)"]])).toEqual({
      ok: false,
      reason: `reviewReceipts[0] range ${c0}..${c1} counts late.txt as binary, but the item's own diff of it is text: review it in ranges that hold it as text`,
    });
  });

  it("local config cannot hide a submodule change from the item diff or uncommitted content from the check", async () => {
    const lib = repo();
    writeFileSync(join(lib, "lib.ts"), "a\n");
    commit(lib, "lib 1");
    const d = repo();
    git(d, "submodule", "add", "-q", lib, "sub");
    const c0 = commit(d, "add submodule");
    const sub = join(d, "sub");
    writeFileSync(join(sub, "lib.ts"), "b\n");
    commit(sub, "lib 2");
    // Committed before the settings, which `git add` would also honour.
    const c1 = commit(d, "bump submodule");
    setConfig(d, "submodule.sub.ignore", "all");
    setConfig(sub, "status.showUntrackedFiles", "no");
    // Suppressed as configured: plain git sees no change at all.
    expect(git(d, "diff", "--numstat", c0)).toBe("");
    expect((await itemNumstat(d, c0)).map((e) => e.path)).toEqual(["sub"]);

    writeFileSync(join(sub, "untracked.ts"), "u\n");
    expect(git(sub, "status", "--porcelain")).toBe("");
    expect(await gate(d, c0, [[c0, c1, "REVIEWED: sub (~2 changed lines)"]])).toEqual({
      ok: false,
      reason: "could not compare sub with the reviewed commits: submodule sub has uncommitted changes, which no reviewed commit holds: commit them in the submodule and review the commit that records it",
    });
  });

  it("a binary blob over any buffer limit is probed by its first 8000 bytes", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "a\n");
    const c0 = commit(d, "base");
    // 40 MiB of NULs, sparse on disk: past the 32 MiB a buffered read would take.
    const fd = openSync(join(d, "big.bin"), "w");
    try { ftruncateSync(fd, 40 * 1024 * 1024); } finally { closeSync(fd); }
    const c1 = commit(d, "a large binary");
    expect(parseNumstatZ(await realProbe.numstat(d, c0, c1))).toEqual([{ path: "big.bin", added: null, deleted: null }]);
    expect((await gate(d, c0, [[c0, c1, "REVIEWED: big.bin (~0 changed lines)"]])).ok).toBe(true);
  });

  it("a range binary on its base side stays binary when its head side is text", async () => {
    const d = repo();
    writeFileSync(join(d, "flip.dat"), Buffer.from([1, 0, 2]));
    const c0 = commit(d, "binary");
    writeFileSync(join(d, "flip.dat"), lines(50));
    const c1 = commit(d, "text");
    expect(git(d, "diff", "--numstat", c0, c1)).toBe("-\t-\tflip.dat");
    expect(parseNumstatZ(await realProbe.numstat(d, c0, c1))).toEqual([{ path: "flip.dat", added: null, deleted: null }]);
  });

  it("a path an attribute masks is probed by its first 8000 bytes, on the blob side and in the working tree", async () => {
    const d = repo();
    writeFileSync(join(d, ".gitattributes"), "masked.txt -diff\n");
    writeFileSync(join(d, "masked.txt"), "a\n");
    const c0 = commit(d, "base");
    // Text for over 8000 bytes, then a NUL: git's probe reads it as text.
    const late = Buffer.concat([Buffer.from(lines(1000)), Buffer.from([0, 10])]);
    expect(late.indexOf(0)).toBeGreaterThanOrEqual(8000);
    writeFileSync(join(d, "masked.txt"), late);
    expect(git(d, "diff", "--numstat", c0)).toBe("-\t-\tmasked.txt");
    // The working tree side.
    expect((await itemNumstat(d, c0)).find((e) => e.path === "masked.txt")?.added).toBeGreaterThan(300);
    // The blob side.
    const c1 = commit(d, "late NUL");
    expect(parseNumstatZ(await realProbe.numstat(d, c0, c1)).find((e) => e.path === "masked.txt")?.added).toBeGreaterThan(300);
  });

  it("with core.fileMode=false an executable bit on disk is not the mode git records", async () => {
    const d = repo();
    setConfig(d, "core.fileMode", "false");
    writeFileSync(join(d, "run.sh"), "x\n");
    chmodSync(join(d, "run.sh"), 0o644);
    const c0 = commit(d, "base");
    writeFileSync(join(d, "run.sh"), "y\n");
    chmodSync(join(d, "run.sh"), 0o755);
    const c1 = commit(d, "change, with an executable bit git ignores");
    expect(git(d, "ls-tree", c1, "run.sh")).toMatch(/^100644 /);
    expect((await gate(d, c0, [[c0, c1, "REVIEWED: run.sh (~2 changed lines)"]])).ok).toBe(true);
  });
});
