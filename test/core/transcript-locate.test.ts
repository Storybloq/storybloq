import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeTranscriptPath, encodeProjectDir, explainTranscriptRefusal, isAuthorizableSessionId, locateTranscript } from "../../src/core/session-intel/transcript-locate.js";
import { SID, writeTranscript } from "./session-intel-fixtures.js";

function withProjects(fn: (base: string, projects: string) => void): void {
  // realpath so returned (resolved) paths compare equal on macOS, where tmpdir is a symlink.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-locate-")));
  try {
    const projects = join(base, "home", ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    fn(base, projects);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe("encodeProjectDir", () => {
  it("replaces every non-alphanumeric byte with a dash", () => {
    expect(encodeProjectDir("/Users/amirshayegh/Developer/CPM")).toBe("-Users-amirshayegh-Developer-CPM");
    expect(encodeProjectDir("/private/tmp/storybloq-bus_spike.x")).toBe("-private-tmp-storybloq-bus-spike-x");
  });
});

describe("authorizeTranscriptPath", () => {
  it("accepts exactly <sessionId>.jsonl one level below the projects dir, returning the real path", () => {
    withProjects((_base, projects) => {
      const path = writeTranscript(projects, "-Users-x-proj", SID, ["{}"]);
      expect(authorizeTranscriptPath(path, SID, projects)).toBe(path);
    });
  });

  it("refuses a mismatched basename, another session's file, a nested or sibling location, and a bad expected id", () => {
    withProjects((base, projects) => {
      const path = writeTranscript(projects, "-Users-x-proj", SID, ["{}"]);
      expect(authorizeTranscriptPath(path, "other-session", projects)).toBeNull();
      const other = writeTranscript(projects, "-Users-x-proj", "other-session", ["{}"]);
      expect(authorizeTranscriptPath(other, SID, projects)).toBeNull();
      const nested = writeTranscript(join(projects, "-Users-x-proj"), "deeper", SID, ["{}"]);
      expect(authorizeTranscriptPath(nested, SID, projects)).toBeNull();
      const outside = writeTranscript(join(base, "elsewhere"), "-Users-x-proj", SID, ["{}"]);
      expect(authorizeTranscriptPath(outside, SID, projects)).toBeNull();
      const top = join(projects, `${SID}.jsonl`);
      writeFileSync(top, "{}");
      expect(authorizeTranscriptPath(top, SID, projects)).toBeNull();
      expect(authorizeTranscriptPath(path, "../x", projects)).toBeNull();
      expect(authorizeTranscriptPath(path, "", projects)).toBeNull();
      expect(authorizeTranscriptPath(`${path}\0`, SID, projects)).toBeNull();
    });
  });

  it("refuses a symlink at the final component, a directory, a FIFO-shaped non-file, and an absent path", () => {
    withProjects((base, projects) => {
      const real = writeTranscript(join(base, "elsewhere"), "-Users-x-proj", SID, ["{}"]);
      mkdirSync(join(projects, "-Users-x-proj"), { recursive: true });
      const link = join(projects, "-Users-x-proj", `${SID}.jsonl`);
      symlinkSync(real, link);
      expect(authorizeTranscriptPath(link, SID, projects)).toBeNull();
      rmSync(link);
      mkdirSync(link);
      expect(authorizeTranscriptPath(link, SID, projects)).toBeNull();
      expect(authorizeTranscriptPath(join(projects, "-Users-y", `${SID}.jsonl`), SID, projects)).toBeNull();
    });
  });

  it("a symlinked PROJECT directory is resolved and then judged by its real location", () => {
    withProjects((base, projects) => {
      // Real file lives outside: refused even though the link sits under projects.
      const real = writeTranscript(join(base, "elsewhere"), "-Users-x-proj", SID, ["{}"]);
      symlinkSync(join(base, "elsewhere", "-Users-x-proj"), join(projects, "-Users-x-proj"));
      expect(authorizeTranscriptPath(join(projects, "-Users-x-proj", `${SID}.jsonl`), SID, projects)).toBeNull();
      expect(real).toBeTruthy();
    });
  });

  it("isAuthorizableSessionId follows the presence session-id pattern", () => {
    expect(isAuthorizableSessionId(SID)).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "-leading", "x".repeat(200), 5]) expect(isAuthorizableSessionId(bad)).toBe(false);
  });
});

describe("locateTranscript", () => {
  it("prefers the hint, then the cwd-encoded directory, then (only when allowed) a one-level glob", () => {
    withProjects((_base, projects) => {
      const hinted = writeTranscript(projects, "-Users-x-hinted", SID, ["{}"]);
      const byCwd = writeTranscript(projects, "-Users-x-proj", SID, ["{}"]);
      const elsewhere = writeTranscript(projects, "-Users-x-other", SID, ["{}"]);
      expect(locateTranscript({ sessionId: SID, cwd: "/Users/x/proj", hint: hinted, allowGlob: false, projectsDir: projects })).toEqual({ path: hinted, source: "hint" });
      expect(locateTranscript({ sessionId: SID, cwd: "/Users/x/proj", hint: "/bogus/x.jsonl", allowGlob: false, projectsDir: projects })).toEqual({ path: byCwd, source: "cwd" });
      expect(locateTranscript({ sessionId: SID, cwd: "/Users/x/none", hint: null, allowGlob: false, projectsDir: projects })).toBeNull();
      const g = locateTranscript({ sessionId: SID, cwd: "/Users/x/none", hint: null, allowGlob: true, projectsDir: projects });
      expect(g?.source).toBe("glob");
      expect([hinted, byCwd, elsewhere]).toContain(g?.path);
    });
  });

  it("never returns a path for an unauthorizable session id or a missing projects dir", () => {
    withProjects((base, projects) => {
      expect(locateTranscript({ sessionId: "../x", cwd: null, hint: null, allowGlob: true, projectsDir: projects })).toBeNull();
      expect(locateTranscript({ sessionId: SID, cwd: null, hint: null, allowGlob: true, projectsDir: join(base, "nope") })).toBeNull();
    });
  });
});

describe("explainTranscriptRefusal (ISS-1224)", () => {
  it("names the failed rule per candidate, with no reason for an authorized path and no path echoed", () => {
    withProjects((base, projects) => {
      const ok = writeTranscript(projects, "-Users-x-proj", SID, ["{}"]);
      expect(explainTranscriptRefusal(ok, SID, projects)).toBeNull();
      const outside = join(base, `${SID}.jsonl`);
      writeFileSync(outside, "{}\n");
      const r1 = explainTranscriptRefusal(outside, SID, projects)!;
      expect(r1).toMatch(/^transcript refused: it is not exactly one directory below the Claude projects directory/);
      expect(r1).not.toContain(base);
      const other = writeTranscript(projects, "-Users-x-proj", "other-session", ["{}"]);
      expect(explainTranscriptRefusal(other, SID, projects)).toBe(`transcript refused: its basename is not ${SID}.jsonl`);
      expect(explainTranscriptRefusal(other, "", projects)).toBe("transcript refused: no session id given; pass --session-id or name the file <sessionId>.jsonl");
      // Same order as the authorizer: an unusable candidate is named before a missing session id.
      expect(explainTranscriptRefusal("", "", projects)).toBe("transcript refused: the path is not an existing regular file (a symlink, directory or absent path is never read)");
      expect(explainTranscriptRefusal(join(projects, "-Users-x-proj", "missing", `${SID}.jsonl`), SID, projects)).toBe("transcript refused: the path is not an existing regular file (a symlink, directory or absent path is never read)");
      const link = join(projects, "-Users-x-proj", "link.jsonl");
      symlinkSync(ok, link);
      expect(explainTranscriptRefusal(link, SID, projects)).toBe(`transcript refused: its basename is not ${SID}.jsonl`);
      const namedLink = join(projects, "-Users-y-proj", `${SID}.jsonl`);
      mkdirSync(join(projects, "-Users-y-proj"), { recursive: true });
      symlinkSync(ok, namedLink);
      expect(explainTranscriptRefusal(namedLink, SID, projects)).toBe("transcript refused: the path is not an existing regular file (a symlink, directory or absent path is never read)");
      expect(authorizeTranscriptPath(namedLink, SID, projects)).toBeNull();
      // Every refusal explained here is one authorizeTranscriptPath also refuses.
      for (const c of [outside, other, link]) expect(authorizeTranscriptPath(c, SID, projects)).toBeNull();
    });
  });
});

describe("the default projects dir follows CLAUDE_CONFIG_DIR (ISS-1270)", () => {
  it("is ~/.claude/projects unset, and <override>/projects when set", async () => {
    const { defaultProjectsDir } = await import("../../src/core/session-intel/transcript-locate.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "si-locate-1270-")));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    try {
      process.env.HOME = base;
      process.env.USERPROFILE = base;
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(defaultProjectsDir()).toBe(join(base, ".claude", "projects"));
      process.env.CLAUDE_CONFIG_DIR = join(base, "cfg");
      expect(defaultProjectsDir()).toBe(join(base, "cfg", "projects"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
});
