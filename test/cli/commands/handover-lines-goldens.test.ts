/**
 * ISS-1499 slice B, commit 1: compatibility goldens (plan section 13, C2,
 * the no-lineage half of C14, the directory, socket and symlink rows of B13,
 * and B14).
 *
 * Every reader of the handovers folder, on projects with no lineage line and
 * no memo, is pinned byte for byte as the code this slice branches from
 * produces it: `handover latest` (raw, --brief, --priming, both; counts 1, 3,
 * 10 and raw 500; md and json; the CLI and the registered MCP tool),
 * `handover template`, `handover list`, `handover get`, `validate`, the
 * compact pointer and `handover create`. Each row runs for a caller with no
 * identity and for one with an inherited identity, and both must equal the
 * one golden (except `handover create`, whose reply differs by identity on
 * main, so it is pinned per identity). Bytes only: read counts are asserted where the reader that
 * makes them is introduced.
 *
 * Regenerate (only on the commit the slice branches from):
 * STORYBLOQ_UPDATE_LINEAGE_GOLDENS=1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { handleSessionResumePrompt } from "../../../src/cli/commands/session-compact.js";
import { isolateEnv, runCli, callMcp, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

// A passthrough of node:fs/promises whose readdir of one chosen folder adds
// one name that does not exist, so "a listed handover is missing at read
// time" (B14) is reproducible without a race.
const phantom = vi.hoisted(() => ({ dir: null as string | null, name: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = (async (path: unknown, ...rest: unknown[]) => {
    const out = await (real.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    if (phantom.dir !== null && phantom.name !== null && String(path) === phantom.dir && Array.isArray(out) && rest.length === 0) {
      return [...(out as string[]), phantom.name];
    }
    return out;
  }) as typeof real.readdir;
  const m = { ...real, readdir };
  return { ...m, default: m };
});

const here = resolve(fileURLToPath(import.meta.url), "..");
const GOLDENS = join(here, "../../fixtures/handover-lineage/main/reader-goldens.json");
const UPDATE = process.env.STORYBLOQ_UPDATE_LINEAGE_GOLDENS === "1";
const IDENTITY = "golden-task-1";
/** Outputs larger than this are pinned by digest and length, with their first bytes kept for reading. */
const INLINE_MAX = 16_384;

interface Golden { out: string | { sha256: string; bytes: number; head: string }; exitCode: number | null; isError: boolean }

let env: IsolatedEnv;
let servers: Server[] = [];
/**
 * The platform's own text for opening a socket, probed live with main's call
 * (root normalised). The socket rows store the token in its place, so the
 * goldens hold on any platform while the text around it stays pinned.
 */
let socketText: string | null = null;
const SOCKET_TOKEN = "<SOCKET_OPEN_ERROR>";
beforeEach(() => { env = isolateEnv(); servers = []; socketText = null; phantom.dir = null; phantom.name = null; });
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  env.restore();
  // chmod 000 files are removable by their owner; the folders stay writable.
  rmSync(env.base, { recursive: true, force: true });
});

const goldens: Record<string, Golden> = !UPDATE && existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};

function pin(text: string, root: string): Golden["out"] {
  let n = text.split(root).join("<ROOT>");
  if (socketText !== null) n = n.split(socketText).join(SOCKET_TOKEN);
  const bytes = Buffer.byteLength(n);
  if (bytes <= INLINE_MAX) return n;
  return { sha256: createHash("sha256").update(n).digest("hex"), bytes, head: n.slice(0, 400) };
}

function check(key: string, got: Golden): void {
  if (UPDATE) {
    const all = existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};
    if (key in all) expect(got, `identity variants of ${key} differ`).toEqual(all[key]);
    all[key] = got;
    mkdirSync(join(GOLDENS, ".."), { recursive: true });
    writeFileSync(GOLDENS, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
    return;
  }
  expect(goldens[key], `no golden for ${key}`).toBeDefined();
  expect(got).toEqual(goldens[key]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const session = (title: string, n: number, pad = 0): string =>
  `# ${title}\n\n## Shipped\n- T-${100 + n} done\n\n## Next\n- T-${200 + n} next, continue the work\n\n` +
  `## Blocked\n- ISS-${300 + n} waiting on review\n\n## Owner-gated\n- Owner decides the release date\n\n` +
  `## Carried forward\n- ISS-${400 + n} still open\n- T-${500 + n} queued\n` +
  (pad > 0 ? `\n## Notes\n${"word ".repeat(Math.ceil(pad / 5))}\n` : "");

/** Name whose JSON-escaped form is over 300 bytes, so the brief does not admit it. */
const LONG_NAME = "2026-11-11-01-" + '"'.repeat(150) + ".md";

/** Mixed names: sequenced and timestamp, undated, hidden, an over-long name, a body over 12,000 bytes. */
const MIXED: Record<string, string> = {
  "2026-11-15-01-alpha.md": session("Alpha", 1),
  "2026-11-15-120000-abcd1234-team.md": session("Team", 2),
  "2026-11-14-02-beta.md": session("Beta", 3),
  "2026-11-14-01-gamma.md": session("Gamma", 4),
  "2026-11-13-01-big.md": session("Big", 5, 13_000),
  "2026-11-12-01-small.md": "# Small\n\nJust a line.\n",
  [LONG_NAME]: session("Long", 6),
  "2026-11-10-01-old1.md": session("Old 1", 7),
  "2026-11-09-01-old2.md": session("Old 2", 8),
  "2026-11-08-01-old3.md": session("Old 3", 9),
  "2026-11-07-01-old4.md": session("Old 4", 10),
  "2026-11-06-01-old5.md": session("Old 5", 11),
  "notes.md": "# Undated notes\n\n## Next\n- T-900 next\n",
  "zz-undated.md": "# Undated two\n",
  ".hidden.md": "# Hidden\n",
};

/** Three ordinary handovers under a special entry that sorts newest. */
const UNDER: Record<string, string> = {
  "2026-11-15-01-alpha.md": session("Alpha", 1),
  "2026-11-14-01-beta.md": session("Beta", 3),
  "2026-11-13-01-gamma.md": session("Gamma", 4),
};
const SPECIAL = "2026-11-16-01-special.md";

/** `n` small handovers dated far in the future, so every one is inside any recent window. */
function many(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  const start = Date.UTC(2099, 0, 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out[`${d}-01-s${String(i).padStart(3, "0")}.md`] = `# S${i}\n\n## Next\n- T-${1000 + i} next\n`;
  }
  return out;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "lineage" });
  const dir = join(root, ".story", "handovers");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

async function special(kind: "dir" | "socket" | "symlink"): Promise<string> {
  const root = await project(UNDER);
  const dir = join(root, ".story", "handovers");
  if (kind === "dir") mkdirSync(join(dir, SPECIAL));
  if (kind === "symlink") symlinkSync("2026-11-15-01-alpha.md", join(dir, SPECIAL));
  if (kind === "socket") {
    // A relative path keeps the socket path under the 104 byte limit.
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const server = createServer();
      await new Promise<void>((r, j) => { server.once("error", j); server.listen(SPECIAL, () => r()); });
      servers.push(server);
    } finally {
      process.chdir(prev);
    }
    socketText = probeSocketText(root);
  }
  return root;
}

/** Main's own read of the socket must throw; its message, root normalised, is the platform text. */
function probeSocketText(root: string): string {
  let message: string | null = null;
  try {
    readFileSync(join(root, ".story", "handovers", SPECIAL), "utf-8");
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, "reading a socket must throw").not.toBeNull();
  return message!.split(root).join("<ROOT>");
}

/** Listing positions are 1-based, newest first, as `listHandovers` orders dated names. */
function nameAt(files: Record<string, string>, position: number): string {
  return Object.keys(files).sort().reverse()[position - 1]!;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

type Who = "none" | "inherited";

function as(who: Who): void {
  if (who === "inherited") process.env.CLAUDE_CODE_SESSION_ID = IDENTITY;
  else delete process.env.CLAUDE_CODE_SESSION_ID;
}

async function cli(root: string, args: readonly string[]): Promise<Golden> {
  const r = await runCli(root, args);
  return { out: pin(r.stdout, root), exitCode: r.exitCode ?? 0, isError: false };
}

async function mcp(root: string, tool: string, args: Record<string, unknown>): Promise<Golden> {
  const r = await callMcp(root, tool, args);
  return { out: pin(r.text, root), exitCode: null, isError: r.isError };
}

async function pointer(root: string, who: Who): Promise<Golden> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  (process.stdout.write as unknown) = (c: string | Uint8Array): boolean => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  try {
    await handleSessionResumePrompt({ source: "compact", cwd: root, ...(who === "inherited" ? { clientTaskId: IDENTITY } : {}) });
  } finally {
    process.stdout.write = orig;
  }
  return { out: pin(chunks.join(""), root), exitCode: null, isError: false };
}

interface LatestMode { readonly name: string; readonly flags: readonly string[]; readonly mcp: Record<string, unknown> }
const MODES: readonly LatestMode[] = [
  { name: "raw", flags: [], mcp: {} },
  { name: "brief", flags: ["--brief"], mcp: { brief: true } },
  { name: "priming", flags: ["--priming"], mcp: { priming: true } },
  { name: "both", flags: ["--brief", "--priming"], mcp: { brief: true, priming: true } },
];

/** Every latest row for one project: modes x counts x formats, on the CLI and through MCP. */
async function latestRows(prefix: string, root: string, who: Who, counts: readonly number[]): Promise<void> {
  for (const mode of MODES) {
    for (const count of counts) {
      for (const format of ["md", "json"] as const) {
        check(`${prefix}/latest/${mode.name}/${count}/cli-${format}`,
          await cli(root, ["handover", "latest", "--count", String(count), ...mode.flags, "--format", format]));
        if (count <= 10) {
          check(`${prefix}/latest/${mode.name}/${count}/mcp-${format}`,
            await mcp(root, "storybloq_handover_latest", { count, ...mode.mcp, format }));
        }
      }
    }
  }
}

const WHO: readonly Who[] = ["none", "inherited"];

// ---------------------------------------------------------------------------
// C2: readers on projects with no lineage
// ---------------------------------------------------------------------------

describe("C2 goldens: no lineage line and no memo", () => {
  for (const who of WHO) {
    describe(`caller identity: ${who}`, () => {
      it("mixed names: latest in every mode, count and format", async () => {
        as(who);
        const root = await project(MIXED);
        await latestRows("mixed", root, who, [1, 3, 10]);
      });

      it("mixed names: template, list, get, validate and the compact pointer", async () => {
        as(who);
        const root = await project(MIXED);
        for (const format of ["md", "json"] as const) {
          check(`mixed/template/cli-${format}`, await cli(root, ["handover", "template", "--format", format]));
          check(`mixed/list/cli-${format}`, await cli(root, ["handover", "list", "--format", format]));
          check(`mixed/list/mcp-${format}`, await mcp(root, "storybloq_handover_list", {}));
          for (const name of ["2026-11-15-01-alpha.md", "2026-11-13-01-big.md", "notes.md"]) {
            check(`mixed/get/${name}/cli-${format}`, await cli(root, ["handover", "get", name, "--format", format]));
          }
          check(`mixed/get/long/cli-${format}`, await cli(root, ["handover", "get", LONG_NAME, "--format", format]));
          check(`mixed/validate/cli-${format}`, await cli(root, ["validate", "--format", format]));
          check(`mixed/validate/mcp-${format}`, await mcp(root, "storybloq_validate", { format }));
        }
        check("mixed/get/alpha/mcp", await mcp(root, "storybloq_handover_get", { filename: "2026-11-15-01-alpha.md" }));
        check("mixed/pointer", await pointer(root, who));
      });

      it("520 handovers inside any recent window: raw 500 and the capped modes", async () => {
        as(who);
        const root = await project(many(520));
        for (const format of ["md", "json"] as const) {
          check(`many/latest/raw/500/cli-${format}`, await cli(root, ["handover", "latest", "--count", "500", "--format", format]));
        }
        await latestRows("many", root, who, [10]);
        check("many/template/cli-md", await cli(root, ["handover", "template", "--format", "md"]));
        check("many/pointer", await pointer(root, who));
      });

      it("handover create: bytes and reply on every surface", async () => {
        as(who);
        for (const surface of ["cli-md", "cli-json", "mcp"] as const) {
          const root = await project(UNDER);
          const dir = join(root, ".story", "handovers");
          const before = new Set(readdirSync(dir));
          const content = "# Created\n\n## Next\n- T-777 next\n";
          const got = surface === "mcp"
            ? await mcp(root, "storybloq_handover_create", { content, slug: "golden" })
            : await cli(root, ["handover", "create", "--content", content, "--slug", "golden", "--format", surface === "cli-json" ? "json" : "md"]);
          const added = readdirSync(dir).filter((f) => !before.has(f));
          expect(added).toHaveLength(1);
          const file = added[0]!;
          expect(file).toMatch(/^\d{4}-\d{2}-\d{2}-01-golden\.md$/);
          expect(readFileSync(join(dir, file), "utf8")).toBe(content);
          const out = typeof got.out === "string" ? got.out.split(file).join("<FILE>") : got.out;
          // The reply differs by identity on main (the handover stamp notice), so
          // create is pinned per identity.
          check(`create/${who}/${surface}`, { ...got, out });
          // No memo folder is created by an unlinked write.
          expect(existsSync(join(root, ".story", "telemetry", "handover-lines"))).toBe(false);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// C14, no-lineage half: the skill's exact read pair through the MCP tool
// ---------------------------------------------------------------------------

describe("C14 no-lineage half: the skill's read pair", () => {
  for (const who of WHO) {
    it(`count 1 priming, then count 10 brief (identity ${who})`, async () => {
      as(who);
      const root = await project(MIXED);
      check("pair/priming", await mcp(root, "storybloq_handover_latest", { count: 1, priming: true }));
      check("pair/brief", await mcp(root, "storybloq_handover_latest", { count: 10, brief: true }));
    });
  }
});

// ---------------------------------------------------------------------------
// B13 goldens: a directory, a socket and a symlink sorting newest
// ---------------------------------------------------------------------------

describe("B13 goldens: special entries sorting newest", () => {
  for (const kind of ["dir", "socket", "symlink"] as const) {
    for (const who of WHO) {
      it(`${kind} (identity ${who})`, async () => {
        as(who);
        const root = await special(kind);
        for (const format of ["md", "json"] as const) {
          for (const count of [1, 3]) {
            check(`${kind}/latest/raw/${count}/cli-${format}`, await cli(root, ["handover", "latest", "--count", String(count), "--format", format]));
          }
          check(`${kind}/latest/brief/3/cli-${format}`, await cli(root, ["handover", "latest", "--count", "3", "--brief", "--format", format]));
          check(`${kind}/latest/priming/3/cli-${format}`, await cli(root, ["handover", "latest", "--count", "3", "--priming", "--format", format]));
          check(`${kind}/template/cli-${format}`, await cli(root, ["handover", "template", "--format", format]));
        }
        check(`${kind}/latest/raw/1/mcp-md`, await mcp(root, "storybloq_handover_latest", { count: 1 }));
        check(`${kind}/pointer`, await pointer(root, who));
      });
    }
  }
});

describe("B13 socket text on the capture platform", () => {
  it.runIf(process.platform === "darwin")("the probed text is the literal the goldens were captured with", async () => {
    await special("socket");
    expect(socketText).toBe(`Unknown system error -102: Unknown system error -102, open '<ROOT>/.story/handovers/${SPECIAL}'`);
  });
});

// ---------------------------------------------------------------------------
// B14 goldens: failure order of raw latest --count 500 over 260 handovers
// ---------------------------------------------------------------------------

const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("B14 goldens: failure order, raw latest --count 500 over 260 files", () => {
  const FILES = many(260);

  for (const who of WHO) {
    it(`a directory at position 3 and an unreadable file at 250: the error is position 3's (identity ${who})`, async () => {
      as(who);
      const root = await project(FILES);
      const dir = join(root, ".story", "handovers");
      const third = nameAt(FILES, 3);
      rmSync(join(dir, third));
      mkdirSync(join(dir, third));
      chmodSync(join(dir, nameAt(FILES, 250)), 0o000);
      for (const format of ["md", "json"] as const) {
        check(`b14/dir3-unreadable250/cli-${format}`, await cli(root, ["handover", "latest", "--count", "500", "--format", format]));
      }
    });

    // Only this row needs permissions enforced; under root the others still hold.
    it.skipIf(runsAsRoot)(`an unreadable file at position 250 alone: its error and no body (identity ${who})`, async () => {
      as(who);
      const root = await project(FILES);
      chmodSync(join(root, ".story", "handovers", nameAt(FILES, 250)), 0o000);
      for (const format of ["md", "json"] as const) {
        const got = await cli(root, ["handover", "latest", "--count", "500", "--format", format]);
        expect(typeof got.out === "string" ? got.out : got.out.head).not.toContain("# S");
        check(`b14/unreadable250/cli-${format}`, got);
      }
    });

    it(`a missing file at position 250 alone is skipped (identity ${who})`, async () => {
      as(who);
      const root = await project(FILES);
      const dir = join(root, ".story", "handovers");
      // Sorts between positions 249 and 250 of the real files.
      const ghost = nameAt(FILES, 250).replace(/-01-s(\d+)\.md$/, "-02-ghost.md");
      phantom.dir = dir;
      phantom.name = ghost;
      for (const format of ["md", "json"] as const) {
        const got = await cli(root, ["handover", "latest", "--count", "500", "--format", format]);
        expect(got.exitCode).toBe(0);
        check(`b14/missing250/cli-${format}`, got);
      }
    });
  }
});
