/**
 * ISS-1497: bundles src/setup-review-supervisor-entry.ts once per run, with the
 * settings tsup.config.ts gives that entry, into a private temp directory that
 * teardown removes. Without it the suite ran dist/setup-review-supervisor.js,
 * so a stale or missing build decided whether setup reviews could start.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { TEST_SUPERVISOR_ENV } from "./helpers/test-supervisor-entry.js";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
let dir: string | null = null;

export async function setup(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "storybloq-test-supervisor-"));
  // .mjs: the temp dir is outside the package's "type": "module" scope, and a Node 20 without syntax detection reads .js there as CommonJS.
  const outfile = join(dir, "setup-review-supervisor.mjs");
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")) as { version: string };
  await build({
    entryPoints: [join(PKG_ROOT, "src", "setup-review-supervisor-entry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
    define: { "process.env.STORYBLOQ_VERSION": JSON.stringify(pkg.version) },
    logLevel: "silent",
  });
  process.env[TEST_SUPERVISOR_ENV] = outfile;
}

export async function teardown(): Promise<void> {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
}
