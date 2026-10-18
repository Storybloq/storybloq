/**
 * A failed session scan is not "no session" (ISS-1347).
 *
 * When the sessions directory cannot be listed, the workspace cannot be
 * resolved, or an entry's containment cannot be checked, nothing was learned
 * about any session. The detailed scans throw, so resume-prompt keeps its
 * marker and says why on stderr; the legacy wrappers keep returning null.
 *
 * Its own file because `node:fs` is mocked for the whole module graph.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hooks = vi.hoisted(() => ({
  readdirFail: null as null | { path: string; code: string },
  realpathFail: null as null | { path: string; code: string },
  nativeFail: null as null | { suffix: string; code: string },
  reads: null as null | string[],
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: mocked`), { code });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = ((p: Parameters<typeof actual.realpathSync>[0], ...rest: unknown[]) => {
    if (hooks.realpathFail && String(p) === hooks.realpathFail.path) throw errno(hooks.realpathFail.code);
    return (actual.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof actual.realpathSync;
  (realpathSync as unknown as Record<string, unknown>).native = ((p: string, ...rest: unknown[]) => {
    if (hooks.nativeFail && String(p).endsWith(hooks.nativeFail.suffix)) throw errno(hooks.nativeFail.code);
    return (actual.realpathSync.native as (...a: unknown[]) => unknown)(p, ...rest);
  });
  return {
    ...actual,
    realpathSync,
    readdirSync: ((p: string, ...rest: unknown[]) => {
      if (hooks.readdirFail && String(p) === hooks.readdirFail.path) throw errno(hooks.readdirFail.code);
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readdirSync,
    readFileSync: ((p: string, ...rest: unknown[]) => {
      if (hooks.reads && String(p).endsWith("state.json")) hooks.reads.push(String(p));
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } = await import("node:fs");
const {
  createSession,
  findActiveSessionDetailed,
  findActiveSessionFull,
  findResumableSessionDetailed,
  findResumableSession,
  SessionScanError,
} = await import("../../src/autonomous/session.js");
const { handleSessionCompactPrepare, handleSessionResumePrompt } = await import(
  "../../src/cli/commands/session-compact.js"
);

const roots: string[] = [];
afterEach(() => {
  hooks.readdirFail = null;
  hooks.realpathFail = null;
  hooks.nativeFail = null;
  hooks.reads = null;
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "storybloq-scan-failure-")));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ name: "test" }));
  return root;
}

const PARKED = {
  state: "COMPACT",
  compactPending: true,
  compactPreparedAt: new Date().toISOString(),
  preCompactState: "IMPLEMENT",
};

function rawSession(root: string, over: Record<string, unknown>): string {
  const id = createSession(root, "default", root).sessionId;
  const path = join(root, ".story", "sessions", id, "state.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), ...over }));
  return id;
}

function markerPath(root: string): string {
  return join(root, ".claude", "rules", "autonomous-resume.md");
}

async function inHook(root: string, fn: () => Promise<unknown>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write);
  const cwd = process.cwd();
  const saved = ["STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT", "STORYBLOQ_GLOBAL_DIR"].map(
    (k) => [k, process.env[k]] as const,
  );
  try {
    delete process.env.STORYBLOQ_PROJECT_ROOT;
    delete process.env.CLAUDESTORY_PROJECT_ROOT;
    process.env.STORYBLOQ_GLOBAL_DIR = join(root, ".global");
    process.chdir(root);
    await fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  }
  return { out: out.join(""), err: err.join("") };
}

/** A parked session and a resume marker: the state a lost marker would hurt. */
function parkedWithMarker(): { root: string; id: string } {
  const root = makeRoot();
  const id = rawSession(root, PARKED);
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(markerPath(root), "resume marker\n");
  return { root, id };
}

describe("listing the sessions directory fails", () => {
  it.each(["EACCES", "EIO"])("%s: resume-prompt keeps the marker and compact-prepare reports it", async (code) => {
    const { root } = parkedWithMarker();
    hooks.readdirFail = { path: join(root, ".story", "sessions"), code };
    const resumed = await inHook(root, () => handleSessionResumePrompt({ source: "compact" }));
    expect(existsSync(markerPath(root))).toBe(true);
    expect(resumed.err).toContain("[storybloq] resume-prompt failed:");
    expect(resumed.err).toContain(code);
    const prepared = await inHook(root, () => handleSessionCompactPrepare({}));
    expect(prepared.err).toContain("[storybloq] compact-prepare failed:");
    expect(prepared.out).toBe("");
  });

  it("the detailed scans throw and the legacy wrappers return null", () => {
    const { root } = parkedWithMarker();
    hooks.readdirFail = { path: join(root, ".story", "sessions"), code: "EACCES" };
    expect(() => findActiveSessionDetailed(root)).toThrow(SessionScanError);
    expect(() => findResumableSessionDetailed(root)).toThrow(SessionScanError);
    expect(findActiveSessionFull(root)).toBeNull();
    expect(findResumableSession(root)).toBeNull();
  });
});

describe("resolving the workspace fails", () => {
  it("the detailed scans throw rather than report no session", () => {
    const { root } = parkedWithMarker();
    hooks.realpathFail = { path: root, code: "EIO" };
    expect(() => findResumableSessionDetailed(root)).toThrow(SessionScanError);
    expect(() => findActiveSessionDetailed(root)).toThrow(SessionScanError);
    expect(findResumableSession(root)).toBeNull();
  });
});

describe("an entry's containment cannot be checked", () => {
  it.each(["EACCES", "EIO"])("%s: resume-prompt keeps the marker and says why", async (code) => {
    const { root, id } = parkedWithMarker();
    hooks.nativeFail = { suffix: join(".story", "sessions", id), code };
    hooks.reads = [];
    const { err } = await inHook(root, () => handleSessionResumePrompt({ source: "compact" }));
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("[storybloq] resume-prompt failed:");
    expect(err).toContain("inside the sessions directory");
    // The candidate was never read.
    expect(hooks.reads.filter((p) => p.includes(id))).toEqual([]);
  });
});

describe("one read per entry", () => {
  it("a damaged and a healthy entry are each read exactly once by a scan", () => {
    const root = makeRoot();
    const damaged = rawSession(root, { ...PARKED, startedAt: null });
    const healthy = rawSession(root, PARKED);
    hooks.reads = [];
    const scan = findResumableSessionDetailed(root);
    expect(scan.match?.info.state.sessionId).toBe(healthy);
    expect(scan.unreadable.map((e) => e.sourceDir)).toEqual([damaged]);
    const reads = hooks.reads;
    expect(reads.filter((p) => p.includes(damaged))).toHaveLength(1);
    expect(reads.filter((p) => p.includes(healthy))).toHaveLength(1);
  });
});
