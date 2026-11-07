// T-538: prepares the Docker build context from the built package: npm pack's own file list, the
// lockfile for npm ci, and the evaluation bundle. Run after `npm run build`, under env -i.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ctx = process.argv[2];
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) { console.error(`${cmd} ${args[0]} failed`); process.exit(1); }
};
if (!ctx) { console.error("usage: stage-context.mjs <empty context folder>"); process.exit(2); }
rmSync(ctx, { recursive: true, force: true });
mkdirSync(join(ctx, "pkg"), { recursive: true });
run(process.execPath, [join(root, "scripts", "build-eval.mjs")], root);
run("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", ctx], root);
const tarball = readdirSync(ctx).find((n) => n.endsWith(".tgz"));
run("tar", ["-xzf", join(ctx, tarball), "-C", join(ctx, "pkg"), "--strip-components", "1"], ctx);
rmSync(join(ctx, tarball));
cpSync(join(root, "package-lock.json"), join(ctx, "pkg", "package-lock.json"));
cpSync(join(root, ".eval-dist"), join(ctx, "pkg", ".eval-dist"), { recursive: true });
for (const name of ["Dockerfile", "proxy.Dockerfile", "proxy.mjs", "relay.mjs", "sup.mjs", "storybloq-launcher"]) cpSync(join(here, name), join(ctx, name));
