/**
 * ISS-1499 slice B, commit 2: the per-call machinery (plan section 3).
 * `TailReader` with its cache, read count and observation flag, and
 * `readHandoverBody` with the reader-level rows of B13. Rows that could
 * block run in a child process under an external deadline of 10 seconds.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:net";
import { TailReader, readHandoverBody } from "../../src/core/handover-selection.js";
import { appendLineage } from "../../src/core/handover-lineage.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const SELECTION_SRC = resolve(here, "../../src/core/handover-selection.ts");
const LINE = '<!-- storybloq-lineage v1 continues="2026-11-09-01-z.md" role="pen" -->';

let base: string;
let hdir: string;
let servers: Server[] = [];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "selection-")));
  hdir = join(base, "handovers");
  mkdirSync(hdir);
  servers = [];
});
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

async function socketAt(name: string): Promise<void> {
  const prev = process.cwd();
  process.chdir(hdir);
  try {
    const server = createServer();
    await new Promise<void>((r, j) => { server.once("error", j); server.listen(name, () => r()); });
    servers.push(server);
  } finally {
    process.chdir(prev);
  }
}

/** Runs `readHandoverBody` in a child under a 10 second deadline; returns its outcome. */
function inChild(name: string, seam?: "dir-to-fifo" | "file-to-fifo"): { ok: boolean; value: string; timedOut: boolean } {
  const script = `
    import { readHandoverBody, bodyReaderSeams } from ${JSON.stringify(SELECTION_SRC)};
    import { rmSync, rmdirSync, unlinkSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const seam = ${JSON.stringify(seam ?? null)};
    if (seam) bodyReaderSeams.afterOpen = (p) => {
      if (seam === "dir-to-fifo") rmdirSync(p); else unlinkSync(p);
      execFileSync("mkfifo", [p]);
    };
    try {
      const body = readHandoverBody(${JSON.stringify(hdir)}, ${JSON.stringify(name)});
      process.stdout.write(JSON.stringify({ ok: true, value: body }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, value: e.message }));
    }
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: resolve(here, "../.."),
  });
  if (r.error || r.signal) return { ok: false, value: String(r.error ?? r.signal), timedOut: true };
  const out = JSON.parse(r.stdout) as { ok: boolean; value: string };
  return { ...out, timedOut: false };
}

describe("TailReader", () => {
  it("caches each name, counts only uncached reads and knows the listing", () => {
    writeFileSync(join(hdir, "2026-11-10-01-a.md"), "# A\n");
    writeFileSync(join(hdir, "2026-11-11-01-b.md"), appendLineage("# B\n", LINE));
    const t = new TailReader(hdir, ["2026-11-11-01-b.md", "2026-11-10-01-a.md"]);
    expect(t.has("2026-11-10-01-a.md")).toBe(true);
    expect(t.has("2026-11-09-01-z.md")).toBe(false);
    expect(t.reads).toBe(0);
    expect(t.state("2026-11-10-01-a.md").state).toBe("unlinked");
    expect(t.reads).toBe(1);
    expect(t.state("2026-11-10-01-a.md").state).toBe("unlinked");
    expect(t.reads).toBe(1);
    expect(t.observation.seen).toBe(false);
    const b = t.state("2026-11-11-01-b.md");
    expect(b.state).toBe("linked");
    expect(b.lineage?.lineage.continues).toEqual({ state: "valid", file: "2026-11-09-01-z.md" });
    expect(t.reads).toBe(2);
    expect(t.observation.seen).toBe(true);
  });

  it("an unknown state does not set the observation", () => {
    mkdirSync(join(hdir, "2026-11-10-01-a.md"));
    const t = new TailReader(hdir, ["2026-11-10-01-a.md"]);
    expect(t.state("2026-11-10-01-a.md").state).toBe("unknown");
    expect(t.observation.seen).toBe(false);
  });
});

describe("readHandoverBody: the same bytes and errors as readFile", () => {
  it("a regular file", async () => {
    const body = "# Café ✓\n\n" + "x".repeat(100_000) + "\n";
    writeFileSync(join(hdir, "a.md"), body);
    expect(readHandoverBody(hdir, "a.md")).toBe(await readFile(join(hdir, "a.md"), "utf-8"));
  });

  it("a symlink to a regular file is followed, as readFile follows it", async () => {
    writeFileSync(join(hdir, "a.md"), "# A\n");
    symlinkSync("a.md", join(hdir, "link.md"));
    expect(readHandoverBody(hdir, "link.md")).toBe(await readFile(join(hdir, "link.md"), "utf-8"));
  });

  it("a missing name raises readFile's error", async () => {
    const want = await readFile(join(hdir, "missing.md"), "utf-8").catch((e: NodeJS.ErrnoException) => e);
    let got: NodeJS.ErrnoException | null = null;
    try { readHandoverBody(hdir, "missing.md"); } catch (e) { got = e as NodeJS.ErrnoException; }
    expect(got?.code).toBe("ENOENT");
    expect(got?.message).toBe((want as Error).message);
  });

  it("a directory raises readFile's EISDIR error", async () => {
    mkdirSync(join(hdir, "dir.md"));
    const want = await readFile(join(hdir, "dir.md"), "utf-8").catch((e: Error) => e);
    expect(() => readHandoverBody(hdir, "dir.md")).toThrow((want as Error).message);
    expect((want as Error).message).toBe("EISDIR: illegal operation on a directory, read");
  });

  it("a socket raises readFile's open error", async () => {
    await socketAt("sock.md");
    const want = await readFile(join(hdir, "sock.md"), "utf-8").catch((e: Error) => e);
    expect(() => readHandoverBody(hdir, "sock.md")).toThrow((want as Error).message);
  });
});

describe("B13 reader rows: never blocks (child process, 10 second deadline)", () => {
  it("a FIFO fails fast with the not-a-regular-file error", () => {
    execFileSync("mkfifo", [join(hdir, "fifo.md")]);
    const r = inChild("fifo.md");
    expect(r.timedOut).toBe(false);
    expect(r).toMatchObject({ ok: false, value: "Cannot read handover fifo.md: not a regular file" });
  });

  it("a directory replaced by a FIFO after the open still raises the directory error", () => {
    mkdirSync(join(hdir, "dir.md"));
    const r = inChild("dir.md", "dir-to-fifo");
    expect(r.timedOut).toBe(false);
    expect(r).toMatchObject({ ok: false, value: "EISDIR: illegal operation on a directory, read" });
  });

  it("a regular file replaced by a FIFO after the open still returns the file's bytes", () => {
    writeFileSync(join(hdir, "a.md"), "# A\n\nbody\n");
    const r = inChild("a.md", "file-to-fifo");
    expect(r.timedOut).toBe(false);
    expect(r).toMatchObject({ ok: true, value: "# A\n\nbody\n" });
  });

  it("the child harness itself reads a regular file", () => {
    writeFileSync(join(hdir, "a.md"), "# A\n");
    expect(inChild("a.md")).toMatchObject({ ok: true, value: "# A\n", timedOut: false });
    expect(readFileSync(join(hdir, "a.md"), "utf8")).toBe("# A\n");
  });
});
