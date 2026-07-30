/**
 * What the `lstat` re-probe of `.story/sessions` actually ESTABLISHED (ISS-897).
 *
 * `readdirSync` follows symlinks, so a dangling `.story/sessions` link raises
 * ENOENT -- the same errno a genuinely absent directory raises. The scanner
 * therefore re-probes with `lstat`, which does not follow, and only an ENOENT
 * from THAT proves absence.
 *
 * The probe has four outcomes and they are not interchangeable. A dangling
 * symlink is the one an operator repoints. A successful lstat on a NON-symlink
 * means the path appeared between the two calls, which is a race, not a broken
 * link. An EACCES or EIO from lstat means the probe itself could not answer.
 * Collapsing all three into "it is a symlink to a path that is not there" sends
 * an operator to fix something that is not there to fix -- so this file drives
 * the two race-only branches through a mocked `node:fs`, since neither can be
 * produced by arranging a real filesystem.
 *
 * All three still fail CLOSED. Only the SENTENCE differs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readdirSync = vi.fn();
const lstatSync = vi.fn();
const readFileSync = vi.fn();

// Real implementations, so each test overrides ONLY the call it is about and
// everything else -- containment, enumeration of a real temp tree -- behaves
// normally. A blanket stub would make the scanner reject the fixture directory
// on containment before it ever reached the probe under test.
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => readdirSync(...args),
    lstatSync: (...args: unknown[]) => lstatSync(...args),
    readFileSync: (...args: unknown[]) => readFileSync(...args),
  };
});

const { scanSessionSummaries } = await import("../../src/core/session-scan.js");

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const roots: string[] = [];

beforeEach(() => {
  readdirSync.mockReset();
  lstatSync.mockReset();
  readFileSync.mockReset();
  readdirSync.mockImplementation(realFs.readdirSync as never);
  lstatSync.mockImplementation(realFs.lstatSync as never);
  readFileSync.mockImplementation(realFs.readFileSync as never);
});

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sessions-root ENOENT re-probe", () => {
  beforeEach(() => {
    // These four are about the ROOT probe, so enumeration must fail with the
    // errno an absent directory and a dangling link both produce.
    readdirSync.mockImplementation(() => {
      throw errno("ENOENT");
    });
  });

  it("stays SILENT when lstat also says ENOENT -- that is genuine absence", () => {
    lstatSync.mockImplementation(() => {
      throw errno("ENOENT");
    });
    const r = scanSessionSummaries("/nowhere");
    expect(r.diagnostics ?? []).toEqual([]);
    expect(r.activeSessions).toEqual([]);
  });

  it("reports the SYMLINK it saw without claiming the target is missing", () => {
    // The two observations are not atomic. readdir's ENOENT and lstat's symlink
    // are separated in time, so "the link is dangling" is an inference, not an
    // observation -- the target may have been removed, or the whole path may
    // have been replaced between the calls. The diagnostic reports the entry it
    // found and stops there.
    lstatSync.mockImplementation(() => ({ isSymbolicLink: () => true }));
    const [d] = scanSessionSummaries("/nowhere").diagnostics ?? [];
    expect(d?.kind).toBe("sessions-dir-unreadable");
    expect(d?.category).toBe("omission");
    expect(d?.reason).toContain("a second look found a SYMLINK entry");
    expect(d?.reason).toContain("not atomic");
  });

  it("does NOT call a non-symlink a broken link -- that is a race, and it says so", () => {
    // readdir saw nothing, lstat found a real directory: the path changed
    // between the two calls. Blaming a symlink would send an operator to repoint
    // a link that does not exist, and the answer they need is "look again".
    lstatSync.mockImplementation(() => ({ isSymbolicLink: () => false }));
    const [d] = scanSessionSummaries("/nowhere").diagnostics ?? [];
    expect(d?.kind).toBe("sessions-dir-unreadable");
    expect(d?.reason).not.toContain("found a SYMLINK entry");
    expect(d?.reason).toContain("the path changed between the two observations");
  });

  it("does NOT call an unreadable probe a broken link, and carries the errno", () => {
    // The probe could not answer at all. Naming the errno is the difference
    // between "your link is broken" and "I could not look", and the second is
    // the one that leads an operator to check permissions.
    lstatSync.mockImplementation(() => {
      throw errno("EACCES");
    });
    const [d] = scanSessionSummaries("/nowhere").diagnostics ?? [];
    expect(d?.kind).toBe("sessions-dir-unreadable");
    expect(d?.reason).not.toContain("found a SYMLINK entry");
    expect(d?.reason).toContain("EACCES");
  });

  it("never emits a DESTRUCTIVE remedy on evidence that cannot support one", () => {
    // The reason string is the whole of what an operator acts on, and none of
    // these three outcomes establishes what is at the path NOW. "Repoint or
    // remove the link" reads as an instruction, and following it on a path that
    // merely changed between two non-atomic calls destroys a working link.
    for (const probe of [
      () => ({ isSymbolicLink: () => true }),
      () => ({ isSymbolicLink: () => false }),
      () => {
        throw errno("EACCES");
      },
    ]) {
      lstatSync.mockImplementation(probe as never);
      const reason = (scanSessionSummaries("/nowhere").diagnostics ?? [])[0]?.reason ?? "";
      for (const forbidden of ["Repoint", "remove the link", "does not resolve", "Delete", "delete it"]) {
        expect(reason, forbidden).not.toContain(forbidden);
      }
    }
  });

  it("fails CLOSED in every non-absent outcome, which is the point of the probe", () => {
    for (const probe of [
      () => ({ isSymbolicLink: () => true }),
      () => ({ isSymbolicLink: () => false }),
      () => {
        throw errno("EIO");
      },
    ]) {
      lstatSync.mockImplementation(probe as never);
      const diags = scanSessionSummaries("/nowhere").diagnostics ?? [];
      expect(diags.map((d) => d.category)).toEqual(["omission"]);
    }
  });
});

describe("the state.json ENOENT re-probe", () => {
  it("does not invent a broken link for a race or an unreadable probe", () => {
    // The SAME four outcomes, one level down. `readFileSync` also follows the
    // link, so a dangling `state.json` raises ENOENT exactly like an unused
    // name. Folding the probe into a boolean forces every non-absent case to
    // share the symlink sentence, and that sentence ends in "repoint or remove
    // it" -- destructive advice, false for a regular file that appeared between
    // the two calls, and false when the probe itself could not answer.
    //
    // Real directory, real enumeration, real containment: only the two calls
    // under test are stubbed, so this exercises the scanner rather than a path
    // built out of mocks.
    const root = mkdtempSync(join(tmpdir(), "storybloq-probe-"));
    roots.push(root);
    mkdirSync(join(root, ".story", "sessions", "sess"), { recursive: true });

    const cases = [
      { probe: null, kind: "state-missing", says: "has no state.json", forbids: "symlink" },
      { probe: true, kind: "state-unreadable", says: "a second look found a SYMLINK entry", forbids: "has no state.json" },
      { probe: false, kind: "state-unreadable", says: "the path changed between the two observations", forbids: "found a SYMLINK entry" },
      { probe: "EACCES", kind: "state-unreadable", says: "EACCES", forbids: "found a SYMLINK entry" },
    ] as const;

    for (const c of cases) {
      readFileSync.mockImplementation((...args: unknown[]) => {
        if (String(args[0]).endsWith("state.json")) throw errno("ENOENT");
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
      });
      lstatSync.mockImplementation((...args: unknown[]) => {
        if (String(args[0]).endsWith("state.json")) {
          if (c.probe === null) throw errno("ENOENT");
          if (typeof c.probe === "string") throw errno(c.probe);
          return { isSymbolicLink: () => c.probe };
        }
        return (realFs.lstatSync as (...a: unknown[]) => unknown)(...args);
      });

      const d = (scanSessionSummaries(root).diagnostics ?? [])[0];
      expect(d?.kind, c.says).toBe(c.kind);
      // Every one of them still conceals, so every one is an omission.
      expect(d?.category, c.says).toBe("omission");
      expect(d?.reason, c.says).toContain(c.says);
      expect(d?.reason, c.says).not.toContain(c.forbids);
      // Same rule as the root probe: nothing here establishes what is at the
      // path now, so nothing here may tell an operator to destroy it.
      for (const forbidden of ["Repoint", "remove it", "Delete", "delete it"]) {
        expect(d?.reason, `${c.says} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
