/**
 * ISS-834: contract tests for the Codex plugin-marketplace packaging.
 *
 * Version-sync: `plugin.json`'s version must move in lockstep with
 * `package.json`'s -- verified empirically that `marketplace.json` carries
 * no version field Codex reads, so this is a two-file check, not three
 * (probe (b), run 10).
 *
 * LICENSE/NOTICE byte-identity: PolyForm Shield's redistribution clause
 * requires both files travel with the software; the plugin directory ships
 * its own copies so it carries them even if extracted independently of the
 * rest of the repo, and this test fails loudly if a canonical-file edit
 * isn't propagated to the copy.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plain x.y.z only: the plugin manifest must never carry a prerelease or
// build suffix that package.json does not, and `toBe(undefined)` on two
// missing fields must not read as "in sync".
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

describe("plugin.json version stays in sync with package.json (ISS-834)", () => {
  it("matches package.json's version exactly, and both are real plain semver strings", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { version?: unknown };
    const plugin = JSON.parse(
      readFileSync(join(pkgRoot, "plugins", "storybloq", ".codex-plugin", "plugin.json"), "utf-8"),
    ) as { version?: unknown };
    expect(typeof pkg.version).toBe("string");
    expect(typeof plugin.version).toBe("string");
    expect(pkg.version).toMatch(PLAIN_SEMVER);
    expect(plugin.version).toMatch(PLAIN_SEMVER);
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json carries no version field of its own and lists exactly the storybloq plugin", () => {
    const marketplace = JSON.parse(
      readFileSync(join(pkgRoot, ".agents", "plugins", "marketplace.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(marketplace).not.toHaveProperty("version");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    // An empty plugins array would satisfy a for-loop of negative assertions
    // while publishing a marketplace that installs nothing: pin the shape.
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(1);
    const entry = plugins[0]!;
    expect(entry.name).toBe("storybloq");
    expect(entry).not.toHaveProperty("version");
    expect(entry.source).toEqual({ source: "local", path: "./plugins/storybloq" });
  });
});

describe("plugin LICENSE/NOTICE are byte-identical to canonical (ISS-834)", () => {
  it("LICENSE matches", () => {
    const canonical = readFileSync(join(pkgRoot, "LICENSE"));
    const copy = readFileSync(join(pkgRoot, "plugins", "storybloq", "LICENSE"));
    expect(copy.equals(canonical)).toBe(true);
  });

  it("NOTICE matches", () => {
    const canonical = readFileSync(join(pkgRoot, "NOTICE"));
    const copy = readFileSync(join(pkgRoot, "plugins", "storybloq", "NOTICE"));
    expect(copy.equals(canonical)).toBe(true);
  });
});

describe("plugin.json license matches package.json's declared license (ISS-834 R2)", () => {
  it("both declare PolyForm-Shield-1.0.0", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { license: string };
    const plugin = JSON.parse(
      readFileSync(join(pkgRoot, "plugins", "storybloq", ".codex-plugin", "plugin.json"), "utf-8"),
    ) as { license: string };
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.license).toBe("PolyForm-Shield-1.0.0");
  });
});
