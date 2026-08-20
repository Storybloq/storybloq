/**
 * ISS-1022: the wiring that makes the presence design's cost claims true.
 *
 * The whole reason presence ships as its own bin is that `dist/cli.js` costs
 * ~310ms per invocation before any hook logic runs, and this hook fires on both
 * PreToolUse and PostToolUse. An accidental import that pulls the CLI
 * dispatcher, the MCP server or ProjectState back into the entry would undo
 * that silently -- nothing would break, every tool call would just get slower.
 * So the import graph is a GATE, not a nicety.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import ts from "typescript";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  PRESENCE_BIN_NAME,
  PRESENCE_HOOK_TIMEOUT_SECONDS,
  PRESENCE_HOOK_TYPES,
  PRESENCE_SUBCOMMAND,
  formatHookCommand,
} from "../../src/core/hook-migration.js";
import { registerPresenceHooks, removePresenceHooks } from "../../src/cli/commands/setup-skill.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";
import { ensureGitignore } from "../../src/cli/commands/hook-status.js";
import { discoverProjectRoot, discoverProjectRootShared } from "../../src/core/project-root-discovery.js";

const REPO = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------

/**
 * Every import form a TS/ESM file can use, because the gate is only as good as
 * its weakest pattern: a `from`-clause-only regex misses side-effect imports
 * (`import "./x.js"`), re-exports, and dynamic `import()`, and any of those
 * could pull the CLI bundle back in without either check here failing.
 */
/**
 * Import extraction via the TypeScript AST, not regexes.
 *
 * The regex version got this wrong twice in review, and the second way was the
 * dangerous one: stripping comments to avoid false positives also stripped
 * anything that LOOKED like a comment inside a string literal, so
 * `const a = "/*"; import "heavy"; const b = "*\/";` hid a real import from the
 * gate entirely. A gate that can be talked out of seeing an import is worse
 * than no gate, because it reports a clean closure it never checked. The
 * compiler's own parser has no such blind spot, and `typescript` is already a
 * direct devDependency.
 */
function specifiersOf(source: string, fileName: string): { resolved: string[]; unresolvable: boolean } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const resolved: string[] = [];
  let unresolvable = false;

  const visit = (node: ts.Node): void => {
    // import ... from "x" / import "x" / export ... from "x" / export * from "x"
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) resolved.push(node.moduleSpecifier.text);
      else unresolvable = true;                       // a template literal specifier
    }
    // import("x", { with: ... }) and require("x")
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteral(first)) resolved.push(first.text);
        else if (first) unresolvable = true;          // computed or template specifier
      }
    }
    // import x = require("y")
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) resolved.push(expr.text);
      else unresolvable = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { resolved, unresolvable };
}

interface Closure {
  /** Repo-relative .ts files reachable from the entry. */
  readonly files: string[];
  /** Every non-relative specifier any of them imports. */
  readonly packages: string[];
  /** Files containing an import that cannot be statically resolved. */
  readonly unresolvable: string[];
}

function importClosure(entry: string): Closure {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const unresolvable = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { resolved, unresolvable: bad } = specifiersOf(readFileSync(file, "utf-8"), file);
    if (bad) unresolvable.add(file.slice(REPO.length + 1));
    for (const specifier of resolved) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return {
    files: [...seen].map((f) => f.slice(REPO.length + 1)).sort(),
    packages: [...packages].sort(),
    unresolvable: [...unresolvable].sort(),
  };
}

describe("presence entry import graph (ISS-1022)", () => {
  it("reaches nothing but src/presence/* and the shared root discovery", () => {
    const closure = importClosure(join(REPO, "src", "hooks", "presence-entry.ts"));

    // The two autonomous files are a deliberate exception, not drift: session
    // ownership precedence has exactly one home (ISS-899), and a per-tool-call
    // hook is the last place a sixth hand-rolled copy should live. Their own
    // closure is those two files and nothing else.
    const allowed = (f: string) =>
      f === "src/hooks/presence-entry.ts" ||
      f.startsWith("src/presence/") ||
      f === "src/core/project-root-shared.ts" ||
      f === "src/autonomous/session-ownership.ts" ||
      f === "src/autonomous/client-profile.ts";

    expect(closure.files.filter((f) => !allowed(f))).toEqual([]);
    // Positive assertion too, so a refactor that empties the closure by
    // accident cannot pass this test vacuously.
    expect(closure.files).toContain("src/core/project-root-shared.ts");
    expect(closure.files).toContain("src/presence/handler.ts");
    expect(closure.files.length).toBeGreaterThanOrEqual(7);
    // A specifier this walker cannot resolve is a hole in the gate, not a pass.
    expect(closure.unresolvable).toEqual([]);
  });

  /**
   * The half that actually protects the cost claim. The file walk above can
   * only see RELATIVE imports; a bare `import { z } from "zod"` anywhere in the
   * closure would sail past it and land 500KB in the bundle. So the
   * non-relative specifiers are enumerated exactly, and the list is node
   * builtins only.
   */
  it("imports no package at all -- only node builtins", () => {
    const { packages } = importClosure(join(REPO, "src", "hooks", "presence-entry.ts"));
    expect(packages.filter((p) => !p.startsWith("node:"))).toEqual([]);
    expect(packages).toEqual(["node:fs", "node:path", "node:string_decoder"]);
  });

  /** Proof the walker sees the forms it claims to, rather than silently matching nothing. */
  it("the walker detects every import form", () => {
    const probe = join(REPO, "dist", "__import-walk-probe.ts");
    writeFileSync(probe, [
      `import "./presence-probe-a.js";`,
      `import { x } from "./presence-probe-b.js";`,
      `export * from "./presence-probe-c.js";`,
      `const d = await import("./presence-probe-d.js");`,
      `const e = require("./presence-probe-e.js");`,
      `import bare from "some-package";`,
      `const f = await import("some-options-package", { with: { type: "json" } });`,
      // The case that defeated regex comment-stripping: a real import between
      // two string literals that merely CONTAIN comment delimiters.
      `const g = "/*"; import "hidden-in-plain-sight"; const h = "*/";`,
    ].join("\n"));
    for (const letter of "abcde") writeFileSync(join(REPO, "dist", `presence-probe-${letter}.ts`), "export const x = 1;\n");
    try {
      const closure = importClosure(probe);
      for (const letter of "abcde") {
        expect(closure.files, `form ${letter} must be detected`).toContain(`dist/presence-probe-${letter}.ts`);
      }
      expect(closure.packages).toContain("some-package");
      // The options form must not slip past the dynamic-import pattern.
      expect(closure.packages).toContain("some-options-package");
      expect(closure.packages, "an import between comment-delimiter strings must still be seen")
        .toContain("hidden-in-plain-sight");
      expect(closure.unresolvable).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
      for (const letter of "abcde") rmSync(join(REPO, "dist", `presence-probe-${letter}.ts`), { force: true });
    }
  });

  /**
   * The shared root discovery is EXTRACTED, not copied: env-var precedence and
   * walk-up semantics are a contract the CLI/MCP reader shares, and two copies
   * would drift the first time either changed. Pinned behaviourally rather than
   * by grepping for a call, because a delegation with the wrong arguments or
   * the wrong callback policy would satisfy a textual check.
   */
  describe("shared root discovery", () => {
    let base: string;
    let project: string;
    let nested: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "presence-roots-"));
      project = join(base, "project");
      nested = join(project, "sub", "inner");
      mkdirSync(join(project, ".story"), { recursive: true });
      writeFileSync(join(project, ".story", "config.json"), "{}");
      mkdirSync(nested, { recursive: true });
      delete process.env.STORYBLOQ_PROJECT_ROOT;
      delete process.env.CLAUDESTORY_PROJECT_ROOT;
    });

    afterEach(() => {
      delete process.env.STORYBLOQ_PROJECT_ROOT;
      delete process.env.CLAUDESTORY_PROJECT_ROOT;
      rmSync(base, { recursive: true, force: true });
    });

    it("walks up to the project, and both entry points agree", () => {
      expect(discoverProjectRootShared(nested)).toBe(project);
      expect(discoverProjectRoot(nested)).toBe(project);
      expect(discoverProjectRootShared(join(base))).toBeNull();
    });

    it("the env override wins and does not walk", () => {
      process.env.STORYBLOQ_PROJECT_ROOT = project;
      expect(discoverProjectRootShared(nested)).toBe(project);
      // Pointing it at a directory that is NOT a project yields null rather
      // than falling back to the walk that would have found one.
      process.env.STORYBLOQ_PROJECT_ROOT = join(base);
      expect(discoverProjectRootShared(nested)).toBeNull();
      expect(discoverProjectRoot(nested)).toBeNull();
    });

    it("the legacy env var is still honoured", () => {
      process.env.CLAUDESTORY_PROJECT_ROOT = project;
      expect(discoverProjectRootShared(join(base))).toBe(project);
    });

    /** With both set, the current variable wins -- untestable one at a time. */
    it("the current env var takes precedence over the legacy one", () => {
      const other = join(base, "other");
      mkdirSync(join(other, ".story"), { recursive: true });
      writeFileSync(join(other, ".story", "config.json"), "{}");
      process.env.STORYBLOQ_PROJECT_ROOT = project;
      process.env.CLAUDESTORY_PROJECT_ROOT = other;
      expect(discoverProjectRootShared(nested)).toBe(project);
      expect(discoverProjectRoot(nested)).toBe(project);
    });

    /**
     * The divergence that matters. An unreadable `.story/` is a TERMINAL
     * boundary for both, but they report it differently: the CLI wrapper raises
     * (its callers want to know), while the presence-facing call fails soft --
     * a hook must never fail a tool call over a directory it cannot read.
     *
     * Crucially neither may WALK PAST it. Doing so would resolve the nested
     * project to the ancestor project above it, and the presence hook would
     * then file one project's session activity into another project's
     * telemetry, with path containment proven against the wrong root.
     */
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "an unreadable .story/ is a terminal boundary, soft for the hook and raising for the CLI",
      () => {
        const inner = join(project, "sub", "innerproject");
        mkdirSync(join(inner, ".story"), { recursive: true });
        writeFileSync(join(inner, ".story", "config.json"), "{}");
        chmodSync(join(inner, ".story"), 0o000);
        try {
          expect(discoverProjectRootShared(inner)).toBeNull();
          expect(() => discoverProjectRoot(inner)).toThrow(/Permission denied/);
          // The ancestor project is RIGHT THERE and must not be returned.
          expect(discoverProjectRootShared(inner)).not.toBe(project);
        } finally {
          chmodSync(join(inner, ".story"), 0o755);
        }
      },
    );
  });

  /** A specifier the walker cannot resolve must be REPORTED, never ignored. */
  it("reports a template-literal import instead of silently skipping it", () => {
    const probe = join(REPO, "dist", "__import-template-probe.ts");
    writeFileSync(probe, "const n = \"x\";\nconst m = await import(`./some-${n}.js`);\n");
    try {
      expect(importClosure(probe).unresolvable).toEqual(["dist/__import-template-probe.ts"]);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  /**
   * The unconditional size gate. The import walk proves nothing HEAVY was
   * pulled in; it cannot prove the allowed local closure has not simply grown.
   * So this builds the presence entry from current source and measures the
   * result, rather than trusting a `dist/` that may be stale or absent.
   */
  it("builds from current source to under 100KB with no heavy dependency", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "presence-bundle-"));
    try {
      const { build } = await import("tsup");
      await build({
        entry: { presence: join(REPO, "src", "hooks", "presence-entry.ts") },
        outDir,
        format: ["esm"],
        target: "node20",
        platform: "node",
        dts: false,
        silent: true,
        clean: true,
      });
      const built = join(outDir, "presence.js");
      expect(existsSync(built), "the presence entry must build standalone").toBe(true);
      const text = readFileSync(built, "utf-8");
      expect(statSync(built).size).toBeLessThan(100 * 1024);
      for (const marker of ["@modelcontextprotocol", "ZodObject", "commander"]) {
        expect(text.includes(marker), `presence bundle must not contain ${marker}`).toBe(false);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * A secondary check, deliberately: the import-graph gates above are the
   * primary one, because they run from SOURCE and cannot inspect a stale
   * artifact. This one confirms the built result and is skipped -- visibly, via
   * `it.skipIf`, never by returning early from a green test -- when there is no
   * build to look at.
   */
  it.skipIf(!existsSync(join(REPO, "dist", "presence.js")))("the built presence bundle stays far below the CLI bundle", () => {
    const built = join(REPO, "dist", "presence.js");
    expect(statSync(built).size).toBeLessThan(100 * 1024);
    const text = readFileSync(built, "utf-8");
    for (const marker of ["@modelcontextprotocol", "ZodObject", "commander"]) {
      expect(text.includes(marker), `presence bundle must not contain ${marker}`).toBe(false);
    }
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Package wiring
// ---------------------------------------------------------------------------

describe("presence package wiring (ISS-1022)", () => {
  it("publishes its own bin, because package.json maps one bin per command", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as { bin: Record<string, string> };
    expect(pkg.bin[PRESENCE_BIN_NAME]).toBe("dist/presence.js");
    expect(pkg.bin.storybloq).toBe("dist/cli.js");
  });

  /**
   * A LEADING SLASH, so the entry pins the root-level directory presence
   * records live in rather than matching any directory named `telemetry` at
   * any depth inside a project's own tracked `.story/` content.
   */
  it("gitignores the telemetry directory, and self-heals existing checkouts", () => {
    expect(STORY_GITIGNORE_ENTRIES).toContain("/telemetry/");

    const root = mkdtempSync(join(tmpdir(), "presence-gitignore-"));
    try {
      const storyDir = join(root, ".story");
      mkdirSync(storyDir);
      writeFileSync(join(storyDir, ".gitignore"), "snapshots/\nstatus.json\n");
      const read = () => readFileSync(join(storyDir, ".gitignore"), "utf-8").split("\n").map((l) => l.trim());
      ensureGitignore(root);
      expect(read()).toContain("/telemetry/");
      // Idempotent -- reread, because asserting on the pre-call snapshot would
      // pass even if the second call appended a duplicate.
      ensureGitignore(root);
      expect(read().filter((l) => l === "/telemetry/")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

describe("presence hook registration (ISS-1022)", () => {
  let settingsPath: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "presence-settings-"));
    settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{}");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function settings(): Record<string, any> {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  it("registers all five hook types", async () => {
    const results = await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    expect(results).not.toBeNull();
    expect(Object.values(results!)).toEqual(PRESENCE_HOOK_TYPES.map(() => "registered"));
    expect(Object.keys(settings().hooks).sort()).toEqual([...PRESENCE_HOOK_TYPES].sort());
  });

  /**
   * The ordering model in one assertion. `async: true` would hand ordering to
   * whichever process finished first, and nothing in a hook payload lets a
   * record reconstruct the true order afterwards -- so every presence hook
   * runs synchronously and inherits Claude Code's own event sequencing.
   */
  it("registers every hook SYNCHRONOUSLY", async () => {
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    for (const hookType of PRESENCE_HOOK_TYPES) {
      for (const group of settings().hooks[hookType]) {
        for (const entry of group.hooks) {
          expect(entry.async, `${hookType} must not be async`).toBeUndefined();
        }
      }
    }
  });

  /**
   * Claude Code's DEFAULT hook timeout is 600 seconds. On a synchronous
   * per-tool-call hook that is a ten-minute stall waiting to happen, not a
   * safety net.
   */
  it("bounds every hook with an explicit short timeout", async () => {
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    expect(PRESENCE_HOOK_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
    for (const hookType of PRESENCE_HOOK_TYPES) {
      for (const group of settings().hooks[hookType]) {
        for (const entry of group.hooks) {
          expect(entry.timeout, `${hookType} must carry an explicit timeout`).toBe(PRESENCE_HOOK_TIMEOUT_SECONDS);
        }
      }
    }
  });

  /** Presence must see every tool and every SessionStart source, `fork` included. */
  it("uses an empty matcher everywhere", async () => {
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    for (const hookType of PRESENCE_HOOK_TYPES) {
      for (const group of settings().hooks[hookType]) {
        expect(group.matcher ?? "").toBe("");
      }
    }
  });

  it("is idempotent", async () => {
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    const second = await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    expect(Object.values(second!)).toEqual(PRESENCE_HOOK_TYPES.map(() => "exists"));
    for (const hookType of PRESENCE_HOOK_TYPES) {
      expect(settings().hooks[hookType].flatMap((g: any) => g.hooks)).toHaveLength(1);
    }
  });

  it("leaves an unrelated hook alone and can be removed again", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "somebody-elses-tool" }] }] },
    }));
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    await removePresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    const remaining = (settings().hooks.PreToolUse ?? []).flatMap((g: any) => g.hooks).map((h: any) => h.command);
    expect(remaining).toEqual(["somebody-elses-tool"]);
  });

  it("registers nothing when the presence bin cannot be resolved", async () => {
    const before = readFileSync(settingsPath, "utf-8");
    expect(await registerPresenceHooks(settingsPath, null)).toBeNull();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("formats the command from the presence bin, not the CLI bin", async () => {
    await registerPresenceHooks(settingsPath, "/fake/bin/storybloq-presence");
    const command = settings().hooks.Stop[0].hooks[0].command;
    expect(command).toBe(formatHookCommand("/fake/bin/storybloq-presence", PRESENCE_SUBCOMMAND));
    expect(command).toContain(PRESENCE_BIN_NAME);
  });
});
