// T-538 S5a: bundles the evaluation entry (scripts/eval-fault-mcp.ts) into
// .eval-dist/eval-mcp.js and .eval-dist/eval-cli.js with tsup.config.ts's own
// options, so the bundle carries the shipped version define and the same
// splitting: false (each entry owns its module instances). .eval-dist/ is
// gitignored and never in package.json `files`. The bundle is cached by
// content: evalInputDigest covers src/, this script, the wrapper, the tsup
// config, package.json and the lockfile, and a run rebuilds when it differs.
//
//   node scripts/build-eval.mjs           build when the digest changed
//   node scripts/build-eval.mjs --force   build regardless
//   node scripts/build-eval.mjs --digest  print the current digest only
//   (--tsup-only is the child process buildEval runs in the package root)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_DIST = ".eval-dist";
// T-538 S5b-0 commit 6a: the in-attempt helper and every script file its bundle pulls in (a test holds this list to the import closure).
export const HELPER_INPUTS = ["scripts/eval-helper.ts", "scripts/continuity-lib.ts", "scripts/onboarding-eval-checkset6.ts", "scripts/onboarding-eval-checkset7-events.ts", "scripts/onboarding-eval-checkset7-writes.ts", "scripts/onboarding-eval-checkset7.ts", "scripts/onboarding-eval-lib.ts", "scripts/onboarding-eval-sessions.ts"];
export const EVAL_INPUTS = ["src", "scripts/eval-fault-mcp.ts", "scripts/build-eval.mjs", "tsup.config.ts", "package.json", "package-lock.json", ...HELPER_INPUTS];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function filesUnder(abs) {
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(abs, d.name)) : d.isFile() ? [join(abs, d.name)] : []));
}

/** sha256 over the sorted (path, sha256) list of every input; a missing input is listed as missing. */
export function evalInputDigest(root) {
  const entries = [];
  for (const input of EVAL_INPUTS) {
    const abs = join(root, input);
    if (!existsSync(abs)) {
      entries.push([input, "missing"]);
      continue;
    }
    for (const file of filesUnder(abs)) entries.push([relative(root, file).split(sep).join("/"), sha256(readFileSync(file))]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(entries.map(([p, h]) => `${p}\u0000${h}\n`).join(""));
}

/** The digest recorded by the last build, or null when there is none. */
export function builtDigest(root) {
  try {
    return JSON.parse(readFileSync(join(root, EVAL_DIST, "build-input.json"), "utf-8")).evalInputDigest ?? null;
  } catch {
    return null;
  }
}

/** Builds when the digest differs from the recorded one (or `force`); returns the digest and whether it built. */
export async function buildEval(root, { force = false } = {}) {
  const digest = evalInputDigest(root);
  if (!force && builtDigest(root) === digest && existsSync(join(root, EVAL_DIST, "eval-mcp.js")) && existsSync(join(root, EVAL_DIST, "eval-cli.js")) && existsSync(join(root, EVAL_DIST, "eval-helper.js"))) {
    return { digest, built: false };
  }
  // tsup reads its config from the working directory: build in a child process run in `root`, never by chdir.
  // Spawned, not spawnSync, so a caller's event loop (a vitest worker's RPC) keeps running through the build.
  const child = spawn(process.execPath, [join(root, "scripts", "build-eval.mjs"), "--tsup-only"], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const status = await new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", done);
  });
  if (status !== 0) throw new Error(`eval build failed (exit ${status}): ${stderr}`);
  writeFileSync(join(root, EVAL_DIST, "build-input.json"), JSON.stringify({ evalInputDigest: digest }, null, 2) + "\n");
  return { digest, built: true };
}

// The script's own path, as a file path (a URL's pathname keeps a space percent-encoded), with symlinks resolved on
// both sides: node resolves its main module, so an unresolved argv would silently skip all of this and exit 0.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(self)) {
  const root = resolve(dirname(self), "..");
  if (process.argv.includes("--tsup-only")) {
    const { build } = await import("tsup");
    await build({
      config: "tsup.config.ts",
      entry: { "eval-mcp": "scripts/eval-fault-mcp.ts", "eval-cli": "scripts/eval-fault-mcp.ts", "eval-helper": "scripts/eval-helper.ts" },
      outDir: EVAL_DIST,
      dts: false,
      clean: true,
      silent: true,
    });
  } else if (process.argv.includes("--digest")) {
    console.log(evalInputDigest(root));
  } else {
    const { digest, built } = await buildEval(root, { force: process.argv.includes("--force") });
    console.log(`${built ? "built" : "up to date"} ${EVAL_DIST} ${digest}`);
  }
}
