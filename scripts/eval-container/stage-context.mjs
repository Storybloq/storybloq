// T-538: prepares the Docker build context from the built package: npm pack's own file list, the
// lockfile for npm ci, and the evaluation bundle. Run after `npm run build`, under env -i.
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) { console.error(`${cmd} ${args[0]} failed`); process.exit(1); }
};
const arg = process.argv[2];
if (!arg) { console.error("usage: stage-context.mjs <missing or empty context folder>"); process.exit(2); }
// Everything below uses this one absolute path: the steps run with different working directories.
const ctx = resolve(arg);
let st = null;
try { st = lstatSync(ctx); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (st !== null && (!st.isDirectory() || readdirSync(ctx).length > 0)) { console.error("refused: the context folder must be missing or an empty folder"); process.exit(2); }
mkdirSync(join(ctx, "pkg"), { recursive: true });
run(process.execPath, [join(root, "scripts", "build-eval.mjs")], root);
run("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", ctx], root);
const tarball = readdirSync(ctx).find((n) => n.endsWith(".tgz"));
run("tar", ["-xzf", join(ctx, tarball), "-C", join(ctx, "pkg"), "--strip-components", "1"], ctx);
unlinkSync(join(ctx, tarball));
cpSync(join(root, "package-lock.json"), join(ctx, "pkg", "package-lock.json"));
cpSync(join(root, ".eval-dist"), join(ctx, "pkg", ".eval-dist"), { recursive: true });
for (const name of ["Dockerfile", "proxy.Dockerfile", "proxy.mjs", "relay.mjs", "sup.mjs", "storybloq-launcher"]) cpSync(join(here, name), join(ctx, name));
