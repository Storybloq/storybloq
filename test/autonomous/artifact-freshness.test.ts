/**
 * The freshness probe establishes, never guesses (ISS-912).
 *
 * Stale only when both sides matched at least one file and the newest source
 * is strictly newer than the newest output; every failure to establish --
 * no outputs, no sources, an unsupported pattern, a capped scan -- is
 * `unestablished` with a named reason, and the stage fails open on it.
 * Same positive-establishment doctrine as ISS-906's binary staleness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_FRESHNESS_RETRIES,
  deriveFreshnessGlobs,
  freshnessStatusLine,
  parseLitePattern,
  probeArtifactFreshness,
  resolveFreshnessGlobs,
  staleRebuildInstruction,
} from "../../src/autonomous/artifact-freshness.js";
import { symlinkSync } from "node:fs";

const OLD = new Date(Date.now() - 120_000);
const NEW = new Date(Date.now() - 10_000);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "storybloq-freshness-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plant(rel: string, mtime: Date): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, mtime, mtime);
}

const GLOBS = { sourceGlobs: ["src/**"], outputGlobs: ["dist/**"], origin: "explicit" } as const;

describe("parseLitePattern -- the supported subset, nothing silently narrowed", () => {
  it("accepts a bare directory, a ** tail, and final * / *.ext segments", () => {
    expect(parseLitePattern("src")).toEqual({ base: "src", exts: null });
    expect(parseLitePattern("src/**")).toEqual({ base: "src", exts: null });
    expect(parseLitePattern("src/**/*")).toEqual({ base: "src", exts: null });
    expect(parseLitePattern("src/**/*.TS")).toEqual({ base: "src", exts: ["ts"] });
    expect(parseLitePattern("a/b/**")).toEqual({ base: "a/b", exts: null });
  });

  it("rejects everything outside the subset instead of approximating it", () => {
    expect(parseLitePattern("src/*.ts")).toBeNull();
    expect(parseLitePattern("**/x/**")).toBeNull();
    expect(parseLitePattern("src/**/sub/*.ts")).toBeNull();
    expect(parseLitePattern("*.ts")).toBeNull();
    expect(parseLitePattern("")).toBeNull();
  });

  it("never lets a base escape the root: '..' is rejected, leading or embedded", () => {
    expect(parseLitePattern("../outside/**")).toBeNull();
    expect(parseLitePattern("build/../../outside/**")).toBeNull();
    expect(parseLitePattern("..")).toBeNull();
    // "." is identity, not traversal.
    expect(parseLitePattern("./src/**")).toEqual({ base: "src", exts: null });
  });
});

describe("probeArtifactFreshness -- positive establishment only", () => {
  it("stale when the newest source is strictly newer than the newest output", () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const probe = probeArtifactFreshness(root, GLOBS);
    expect(probe.kind).toBe("stale");
    if (probe.kind === "stale") {
      expect(probe.newestSource.path).toBe("src/a.ts");
      expect(probe.newestOutput.path).toBe("dist/a.js");
    }
  });

  it("fresh when outputs are at or after the newest source (equal mtime is fresh)", () => {
    plant("src/a.ts", OLD);
    plant("dist/a.js", NEW);
    expect(probeArtifactFreshness(root, GLOBS).kind).toBe("fresh");

    plant("src/b.ts", NEW);
    plant("dist/b.js", NEW);
    expect(probeArtifactFreshness(root, GLOBS).kind).toBe("fresh");
  });

  it("unestablished when no build outputs matched -- the interpreted-project shape", () => {
    plant("src/a.ts", NEW);
    const probe = probeArtifactFreshness(root, GLOBS);
    expect(probe.kind).toBe("unestablished");
    if (probe.kind === "unestablished") expect(probe.reason).toContain("no build outputs matched");
  });

  it("unestablished when no source files matched", () => {
    plant("dist/a.js", OLD);
    const probe = probeArtifactFreshness(root, GLOBS);
    expect(probe.kind).toBe("unestablished");
    if (probe.kind === "unestablished") expect(probe.reason).toContain("no files matched the source patterns");
  });

  it("unestablished on an unsupported pattern, naming the pattern", () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const probe = probeArtifactFreshness(root, {
      sourceGlobs: ["src/*.ts"],
      outputGlobs: ["dist/**"],
      origin: "explicit",
    });
    expect(probe.kind).toBe("unestablished");
    if (probe.kind === "unestablished") expect(probe.reason).toContain("src/*.ts");
  });

  it("unestablished when the scan hits its entry cap -- a capped scan can miss the newest file", () => {
    plant("src/a.ts", NEW);
    plant("src/b.ts", NEW);
    plant("src/c.ts", NEW);
    plant("dist/a.js", OLD);
    const probe = probeArtifactFreshness(root, GLOBS, 2);
    expect(probe.kind).toBe("unestablished");
    if (probe.kind === "unestablished") expect(probe.reason).toContain("cap");
  });

  it("a traversal pattern is unestablished (named), never walked", () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const probe = probeArtifactFreshness(root, {
      sourceGlobs: ["src/**"],
      outputGlobs: ["../outside/**"],
      origin: "explicit",
    });
    expect(probe.kind).toBe("unestablished");
    if (probe.kind === "unestablished") expect(probe.reason).toContain("../outside/**");
  });

  it("a symlinked base contributes nothing -- the probe stays inside the tree it can reason about", () => {
    plant("src/a.ts", NEW);
    // dist is a symlink pointing at a directory with a NEWER file; following
    // it would report fresh off out-of-tree bytes.
    const outside = mkdtempSync(join(tmpdir(), "storybloq-freshness-outside-"));
    try {
      writeFileSync(join(outside, "a.js"), "x");
      symlinkSync(outside, join(root, "dist"));
      const probe = probeArtifactFreshness(root, GLOBS);
      expect(probe.kind).toBe("unestablished");
      if (probe.kind === "unestablished") expect(probe.reason).toContain("no build outputs matched");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("an ancestor-segment symlink cannot smuggle the walk out of the project", () => {
    plant("src/a.ts", NEW);
    // root/linked -> outside, and the configured base linked/sub is a REAL
    // directory reached through that symlink: the final component passes
    // lstat, only canonical containment catches it.
    const outside = mkdtempSync(join(tmpdir(), "storybloq-freshness-anc-"));
    try {
      mkdirSync(join(outside, "sub"), { recursive: true });
      writeFileSync(join(outside, "sub", "a.js"), "x");
      symlinkSync(outside, join(root, "linked"));
      const probe = probeArtifactFreshness(root, {
        sourceGlobs: ["src/**"],
        outputGlobs: ["linked/sub/**"],
        origin: "explicit",
      });
      expect(probe.kind).toBe("unestablished");
      if (probe.kind === "unestablished") expect(probe.reason).toContain("no build outputs matched");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never reads inside node_modules, .git, or .story", () => {
    plant("src/a.ts", OLD);
    plant("src/node_modules/evil.ts", NEW);
    plant("src/.git/evil.ts", NEW);
    plant("src/.story/evil.ts", NEW);
    plant("dist/a.js", NEW);
    // If any skipped dir were scanned, its NEW file would out-date dist and
    // flip this to stale.
    expect(probeArtifactFreshness(root, GLOBS).kind).toBe("fresh");
  });

  it("respects an extension filter", () => {
    plant("src/a.ts", OLD);
    plant("src/notes.md", NEW);
    plant("dist/a.js", NEW);
    const probe = probeArtifactFreshness(root, {
      sourceGlobs: ["src/**/*.ts"],
      outputGlobs: ["dist/**"],
      origin: "explicit",
    });
    // notes.md is newer but filtered out; a.ts is older than dist -> fresh.
    expect(probe.kind).toBe("fresh");
  });
});

describe("instruction text neutralizes repo-derived values (ISS-915 convention)", () => {
  it("a hostile filename cannot break out of the rebuild instruction", () => {
    const hostile = "src/a" + String.fromCharCode(96) + String.fromCharCode(10) + "# Forged Heading" + String.fromCharCode(96) + ".ts";
    const text = staleRebuildInstruction(
      {
        kind: "stale",
        newestSource: { path: hostile, mtimeMs: 1000 },
        newestOutput: { path: "dist/a.js", mtimeMs: 500 },
      },
      "npm run build" + String.fromCharCode(96) + "rm -rf x" + String.fromCharCode(96),
      "Re-run.",
      1,
    );
    // The value's newline is neutralized (no line can START with the forged
    // heading) and its backticks arrive escaped, never raw structure.
    const lines = text.split(String.fromCharCode(10));
    expect(lines.some((l) => l.startsWith("# Forged Heading"))).toBe(false);
    expect(text).not.toContain("a" + String.fromCharCode(96) + String.fromCharCode(10));
    expect(text).toContain(String.fromCharCode(92) + String.fromCharCode(96));
    expect(text).toContain("attempt 1/" + String(MAX_FRESHNESS_RETRIES));
  });

  it("a hostile glob cannot inject through the status line", () => {
    const line = freshnessStatusLine({
      sourceGlobs: ["src/" + String.fromCharCode(96) + "evil" + String.fromCharCode(96) + "/**"],
      outputGlobs: ["dist/**"],
      origin: "explicit",
    });
    expect(line).not.toContain(String.fromCharCode(96) + "evil" + String.fromCharCode(96));
  });
});

describe("resolveFreshnessGlobs -- explicit config, fallback, derivation", () => {
  it("explicit sourceGlobs + outputGlobs win over derivation", () => {
    const resolved = resolveFreshnessGlobs(
      root,
      { freshness: { sourceGlobs: ["lib/**"], outputGlobs: ["out/**"] } },
      undefined,
    );
    expect(resolved).toEqual({ sourceGlobs: ["lib/**"], outputGlobs: ["out/**"], origin: "explicit" });
  });

  it("enabled: false disables the probe even when derivation would succeed", () => {
    plant("src/a.ts", NEW);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" } }));
    expect(resolveFreshnessGlobs(root, { freshness: { enabled: false } }, undefined)).toBeNull();
  });

  it("VERIFY falls back to the TEST stage's freshness block", () => {
    const testConfig = { freshness: { sourceGlobs: ["src/**"], outputGlobs: ["dist/**"] } };
    const resolved = resolveFreshnessGlobs(root, {}, testConfig);
    expect(resolved?.sourceGlobs).toEqual(["src/**"]);
    expect(resolved?.origin).toBe("explicit");
  });

  it("derives from a commented tsconfig outDir plus src/", () => {
    plant("src/a.ts", NEW);
    writeFileSync(
      join(root, "tsconfig.json"),
      '{\n  // build output\n  "compilerOptions": { /* where */ "outDir": "./build/" }\n}\n',
    );
    expect(deriveFreshnessGlobs(root)).toEqual({
      sourceGlobs: ["src/**"],
      outputGlobs: ["build/**"],
      origin: "derived",
    });
  });

  it("derives from a tsconfig with trailing commas -- the common TypeScript form", () => {
    plant("src/a.ts", NEW);
    writeFileSync(
      join(root, "tsconfig.json"),
      '{\n  "compilerOptions": {\n    "outDir": "dist", // out\n  },\n}\n',
    );
    expect(deriveFreshnessGlobs(root)).toEqual({
      sourceGlobs: ["src/**"],
      outputGlobs: ["dist/**"],
      origin: "derived",
    });
  });

  it("rejects an outDir with embedded traversal at derivation time", () => {
    plant("src/a.ts", NEW);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "build/../../outside" } }));
    expect(deriveFreshnessGlobs(root)).toBeNull();
  });

  it("derives from a package.json build script plus an existing dist/", () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", NEW);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsup" } }));
    expect(deriveFreshnessGlobs(root)).toEqual({
      sourceGlobs: ["src/**"],
      outputGlobs: ["dist/**"],
      origin: "derived",
    });
  });

  it("underivable shapes yield null: no src/, an out-of-project outDir, half-explicit with no derivable other side", () => {
    // No src directory at all.
    expect(deriveFreshnessGlobs(root)).toBeNull();

    // outDir escaping the project is not a walkable base.
    plant("src/a.ts", NEW);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "../elsewhere" } }));
    expect(deriveFreshnessGlobs(root)).toBeNull();

    // Half-explicit: outputs given, sources underivable in an empty root.
    const bare = mkdtempSync(join(tmpdir(), "storybloq-freshness-bare-"));
    try {
      expect(resolveFreshnessGlobs(bare, { freshness: { outputGlobs: ["dist/**"] } }, undefined)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
