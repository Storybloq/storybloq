/**
 * ISS-1499 slice A, A15: an old reader (storybloq 1.16.0, which knows
 * nothing of lineage) reads a folder of linked handovers exactly as it reads
 * the same folder with the lineage lines removed. The version is named
 * literally; it is not LATEST_PUBLISHED, which moves at every publish.
 *
 * The dist comes from the prefix `npm run compat:fetch` installs
 * (old-dists.ts): skipped without it, a failure in required mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { appendLineage, parseLineageLine, splitLineage } from "../../src/core/handover-lineage.js";
import { requireOldDists } from "./old-dists.js";

const { dists, skip } = requireOldDists(["1.16.0"]);
const bin = dists[0]?.bin ?? "";

let scratch: string;
let home: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "lineage-old-reader-")));
  home = join(scratch, "home");
  mkdirSync(home);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const env = () => ({ HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig") });

function old(root: string, args: readonly string[]): unknown {
  const out = execFileSync(bin, [...args], { cwd: root, encoding: "utf8", env: env(), timeout: 60_000 });
  const parsed = JSON.parse(out) as { version: number; data?: unknown; error?: unknown };
  expect(parsed.error, out).toBeUndefined();
  return parsed.data;
}

/** `handover latest --count N` without --brief prints one JSON document per handover, back to back. */
function oldEach(root: string, args: readonly string[]): unknown[] {
  const out = execFileSync(bin, [...args], { cwd: root, encoding: "utf8", env: env(), timeout: 60_000 });
  return out.split(/\n(?=\{)/).map((doc) => {
    const parsed = JSON.parse(doc) as { version: number; data?: unknown; error?: unknown };
    expect(parsed.error, doc).toBeUndefined();
    return parsed.data;
  });
}

async function project(files: Record<string, string>): Promise<string> {
  const root = join(scratch, `p-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root);
  await initProject(root, { name: "lineage" });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, ".story", "handovers", name), body);
  return root;
}

const session = (n: number, extra = ""): string =>
  `# Session ${n}\n\n## Shipped\n- T-00${n} done\n\n## Next\n- T-01${n} next\n\n## Blocked\n- ISS-02${n} waiting on review\n\n## Carried forward\n- ISS-03${n} still open\n${extra}`;

/** Four handovers on one line, the newest with a role, an absorbs and a by. */
const LINKED: Record<string, string> = {
  "2026-11-10-01-a.md": appendLineage(session(1), '<!-- storybloq-lineage v1 role="pen" at="abc1234" by="a@b.c" -->'),
  "2026-11-11-01-b.md": appendLineage(session(2), '<!-- storybloq-lineage v1 continues="2026-11-10-01-a.md" role="pen" -->'),
  "2026-11-12-01-side.md": appendLineage(session(3), '<!-- storybloq-lineage v1 role="worker" -->'),
  "2026-11-13-01-c.md": appendLineage(session(4), '<!-- storybloq-lineage v1 continues="2026-11-11-01-b.md" absorbs="2026-11-12-01-side.md" role="pen" by="a@b.c" -->'),
};
const STRIPPED: Record<string, string> = Object.fromEntries(Object.entries(LINKED).map(([n, c]) => [n, splitLineage(c).body]));

/** A valid lineage line of exactly `bytes` bytes, padded with absorbs names. */
function lineOfBytes(bytes: number): string {
  const head = '<!-- storybloq-lineage v1 continues="2026-11-10-01-a.md"';
  const tail = ' role="pen" by="a@b.c" -->';
  let absorbs = "";
  let i = 0;
  for (;;) {
    const left = bytes - head.length - tail.length - absorbs.length;
    if (left === 0) break;
    const wrap = ' absorbs="'.length + '"'.length;
    const nameLen = Math.min(255, left - wrap);
    expect(nameLen, "the padding must leave room for a name").toBeGreaterThanOrEqual(10);
    const stem = `2026-01-0${i}-`;
    absorbs += ` absorbs="${stem}${"x".repeat(nameLen - stem.length - 3)}.md"`;
    i++;
  }
  const line = head + absorbs + tail;
  expect(Buffer.byteLength(line)).toBe(bytes);
  const parsed = parseLineageLine(line);
  expect(parsed?.dropped).toEqual([]);
  return line;
}

describe.skipIf(skip !== null)(`A15 old reader (storybloq 1.16.0)${skip ? ` (${skip})` : ""}`, () => {
  it("is the pinned version", () => {
    expect(execFileSync(bin, ["--version"], { encoding: "utf8", env: env() }).trim()).toBe("1.16.0");
  });

  it("handover latest --count 10 --brief: the same records, ids and trajectory with and without the lineage lines", async () => {
    for (const [n, c] of Object.entries(LINKED)) expect(c, n).not.toBe(STRIPPED[n]);
    const linked = await project(LINKED);
    const stripped = await project(STRIPPED);
    const args = ["handover", "latest", "--count", "10", "--brief", "--format", "json"];
    const a = old(linked, args) as { handovers: { form: string; records: unknown[] }[]; trajectory: unknown[] };
    const b = old(stripped, args);
    expect(a.handovers).toHaveLength(4);
    expect(a.handovers.every((h) => h.form === "structured" && h.records.length > 0)).toBe(true);
    expect(a.trajectory.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("handover latest --count 3: raw bodies differ only by the line itself", async () => {
    const linked = await project(LINKED);
    const stripped = await project(STRIPPED);
    const args = ["handover", "latest", "--count", "3", "--format", "json"];
    const a = oldEach(linked, args) as { filename: string; content: string }[];
    const b = oldEach(stripped, args) as { filename: string; content: string }[];
    expect(a.map((h) => h.filename)).toEqual(["2026-11-13-01-c.md", "2026-11-12-01-side.md", "2026-11-11-01-b.md"]);
    expect(b.map((h) => h.filename)).toEqual(a.map((h) => h.filename));
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.content).toBe(LINKED[a[i]!.filename]);
      expect(b[i]!.content).toBe(STRIPPED[a[i]!.filename]);
      const split = splitLineage(a[i]!.content);
      expect(split.lineage, a[i]!.filename).not.toBeNull();
      expect(split.body).toBe(b[i]!.content);
    }
  });

  it("C5 with --priming and a 1,024 byte line: 12,000 bytes stays raw, one byte more is structured with the same records as the body with no line", async () => {
    const line = lineOfBytes(1024);
    const bodyOfFile = (fileBytes: number): string => {
      const base = session(5, "\n## Notes\n");
      const pad = fileBytes - Buffer.byteLength(appendLineage(base + "y\n", line));
      expect(pad).toBeGreaterThan(0);
      return base + "y".repeat(pad + 1) + "\n";
    };
    const atLimit = bodyOfFile(12_000);
    const over = bodyOfFile(12_001);
    expect(Buffer.byteLength(appendLineage(atLimit, line))).toBe(12_000);
    expect(Buffer.byteLength(appendLineage(over, line))).toBe(12_001);
    expect(Buffer.byteLength(atLimit)).toBe(12_000 - 1024 - 2);

    const name = "2026-11-13-01-p.md";
    const priming = ["handover", "latest", "--count", "1", "--priming", "--format", "json"];
    type Primed = { handovers: { filename: string; form: string; body?: string; records?: unknown[] }[] };

    const raw = old(await project({ [name]: appendLineage(atLimit, line) }), priming) as Primed;
    expect(raw.handovers[0]).toMatchObject({ filename: name, form: "raw", body: appendLineage(atLimit, line) });

    const structured = old(await project({ [name]: appendLineage(over, line) }), priming) as Primed;
    expect(structured.handovers[0]!.form).toBe("structured");
    const noLine = old(await project({ [name]: over }), ["handover", "latest", "--count", "1", "--brief", "--format", "json"]) as Primed;
    expect(noLine.handovers[0]!.form).toBe("structured");
    expect(structured.handovers[0]!.records!.length).toBeGreaterThan(0);
    expect(structured.handovers[0]!.records).toEqual(noLine.handovers[0]!.records);
    expect(structured).toEqual(noLine);
  });
});
