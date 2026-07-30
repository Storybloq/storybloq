/**
 * The deletion race, tested at the only place it is observable (ISS-897).
 *
 * `scanSessionSummaries` enumerates `.story/sessions` and then reads each
 * entry's `state.json`. A session removed BETWEEN those two steps is reported
 * by `readdirSync` as a directory and is gone by the time the read runs, which
 * produces exactly the observations a half-created session produces: ENOENT on
 * the file, and nothing at that name.
 *
 * The two must not be treated alike. A half-created session is a genuine gap --
 * something may be running there and this build cannot tell -- so it is an
 * `omission` and the scan is `incomplete`. A deleted one conceals nothing:
 * there is no session there. Diagnosing it drives the guard to `unverifiable`
 * over a directory that does not exist, with a remedy naming a path the
 * operator will not find, and a project can be blocked by a session someone
 * cleaned up a moment earlier. `readSessionStrict` already separates these
 * (`missing` vs `missing-state`); the scanner has to agree or the two surfaces
 * contradict each other about one path.
 *
 * This needs its own FILE because the interleaving cannot be produced by
 * ordinary filesystem calls: removing the directory before the scan means the
 * scanner's own `readdirSync` never sees it, and removing it after means the
 * read already happened. `readdirSync` is stubbed to report one entry that is
 * not on disk, which IS the race, observed from the scanner's point of view.
 * Everything else -- the state read, both probes -- runs against the real
 * filesystem.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PHANTOM = "vanished-mid-scan";
/**
 * A directory the second probe cannot look at.
 *
 * The skip and the `state-missing` claim both hang on the SAME second probe,
 * and it has three answers, not two. `absent` proves the race; `present` proves
 * a real half-created session; `probe-failed` -- EACCES on an ancestor, EIO on
 * the device -- proves neither, and a build that folds it in with `present`
 * tells the operator "this session directory has no state.json" about a
 * directory nothing established is there. `lstat` is stubbed for this one path
 * because a permission failure on an ancestor cannot be staged portably (root
 * ignores the mode bits, and CI often runs as root).
 */
const BLOCKED = "probe-blocked";
/**
 * A directory `readdirSync` reported, replaced before the state read.
 *
 * `probePath` answers `present` for a symlink -- correct for "does anything
 * exist here", wrong for the one caller that goes on to say "this session
 * DIRECTORY has no state.json". The remedy that sentence carries would have
 * someone write a state file through the link.
 */
const SWAPPED = "swapped-for-symlink";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readdirSync: ((path: string, options?: unknown) => {
      const real = (actual.readdirSync as (p: string, o?: unknown) => unknown[])(path, options);
      // Only for a sessions root, and only when the caller asked for Dirents --
      // otherwise this would perturb unrelated reads.
      if (!String(path).endsWith(join(".story", "sessions"))) return real;
      if (!(options as { withFileTypes?: boolean } | undefined)?.withFileTypes) return real;
      // A Dirent for a directory that is NOT there. `isDirectory()` is what the
      // scanner branches on, and readdir does not re-stat.
      return [
        ...real,
        {
          name: PHANTOM,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
        },
      ];
    }) as typeof actual.readdirSync,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      // Only the DIRECTORY, so `state.json` under it still answers ENOENT
      // honestly and `probeStateName` still returns `absent`. That is the
      // combination under test: the file probe proves the name is unused and
      // the directory probe cannot say whether the directory is there at all.
      if (String(path).endsWith(join(".story", "sessions", BLOCKED))) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      // A real `lstat` result with the DIRECTORY bit turned off, which is what
      // an operator sees after a directory is replaced by a symlink between
      // `readdirSync` and the state read. Only the type is overridden, so
      // everything else about the entry stays honest.
      if (String(path).endsWith(join(".story", "sessions", SWAPPED))) {
        const real = (actual.lstatSync as (p: string) => { isDirectory: () => boolean })(path);
        return { ...real, isDirectory: () => false, isSymbolicLink: () => true };
      }
      return (actual.lstatSync as (p: string, ...r: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.lstatSync,
  };
});

const { scanSessionSummaries } = await import("../../src/core/session-scan.js");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-scan-race-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

describe("a session removed between enumeration and read (ISS-897)", () => {
  it("is skipped in silence, not reported as a gap", () => {
    const root = makeRoot();
    const r = scanSessionSummaries(root);

    // The phantom really did reach the scanner -- otherwise this test would
    // pass by exercising nothing at all.
    expect(r.diagnostics.map((d) => d.sourceDir)).not.toContain(PHANTOM);
    expect(r.diagnostics, JSON.stringify(r.diagnostics)).toEqual([]);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
  });

  it("while a directory that IS there with no state.json still is", () => {
    // The control, and the reason the skip is conditioned on a SECOND probe
    // rather than on the state-file probe alone. These two cases produce the
    // same answer from `probeStateName`; only the directory probe separates
    // them, so a fix keyed on the first would silence a real gap as well.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "half-created"), { recursive: true });

    const r = scanSessionSummaries(root);
    const named = r.diagnostics.map((d) => d.sourceDir);
    expect(named).toContain("half-created");
    expect(named).not.toContain(PHANTOM);

    const d = r.diagnostics.find((x) => x.sourceDir === "half-created")!;
    expect(d.kind).toBe("state-missing");
    expect(d.category).toBe("omission");
  });

  it("but an INCONCLUSIVE second probe is neither skipped nor called state-missing", () => {
    // The third answer. `probeStateName` says the `state.json` name is unused,
    // which by itself is raised both by a live directory with no state file in
    // it AND by a directory that is no longer there -- the errno cannot tell
    // them apart, which is why the second probe exists. Here that probe fails
    // rather than answering, so BOTH conclusions are unavailable: the record is
    // not skipped (that would need proven absence) and it is not
    // `state-missing` (that would claim the directory is there).
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", BLOCKED), { recursive: true });

    const r = scanSessionSummaries(root);
    const d = r.diagnostics.find((x) => x.sourceDir === BLOCKED);
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();

    expect(d!.kind).toBe("state-unreadable");
    // Still an omission, so the scan is still incomplete and the guard still
    // stops. What changes is only what the operator is told they are seeing.
    expect(d!.category).toBe("omission");
    expect(d!.reason).not.toContain("This session directory has no state.json");
    expect(d!.reason).toContain("could not establish");
    expect(d!.reason).toContain("do not delete");
  });

  it("does not call a REPLACED entry a directory missing its state file", () => {
    // The third answer the second probe can give, and the one `probePath`
    // hides: the name is still there, but it is not a directory any more.
    // Reported as `state-missing`, the remedy tells an operator to create a
    // state.json at a path that is now a link -- so the write lands wherever
    // the link points. The scanner also has to agree with its own
    // non-directory branch, which diagnoses exactly this shape when
    // `readdirSync` sees it in time.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", SWAPPED), { recursive: true });

    const r = scanSessionSummaries(root);
    const d = r.diagnostics.find((x) => x.sourceDir === SWAPPED);
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();

    expect(d!.kind).toBe("state-unreadable");
    expect(d!.category).toBe("omission");
    expect(d!.reason).not.toContain("This session directory has no state.json");
    expect(d!.reason).toContain("NOT a directory any more");
    expect(d!.reason).toContain("Do not delete anything");
  });

  it("and a real session beside the phantom is still classified", () => {
    // The skip must not swallow the entry after it. A `continue` in the wrong
    // place would end the loop's useful work at the first phantom.
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "aaaa1111-2222-4333-8444-555555555555");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "aaaa1111-2222-4333-8444-555555555555",
        recipe: "coding",
        state: "IMPLEMENT",
        revision: 1,
        status: "active",
        lease: {
          workspaceId: "ws",
          lastHeartbeat: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );

    const r = scanSessionSummaries(root);
    expect(r.activeSessions.map((s) => s.sourceDir)).toEqual([
      "aaaa1111-2222-4333-8444-555555555555",
    ]);
    expect(r.diagnostics).toEqual([]);
  });
});
