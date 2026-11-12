/**
 * T-538 S0 (pen ruling G5), test only: preloaded into the runner child by NODE_OPTIONS. Every content read under
 * T538_SPY_HOME (the child's fake real home) is appended to T538_SPY_LOG and refused. Metadata calls (lstat, exists)
 * pass. The named ESM exports of node:fs are re-synced so modules that import them see the wrapped functions.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.T538_SPY_HOME;
const log = process.env.T538_SPY_LOG;
if (home && log) {
  const append = fs.appendFileSync;
  const under = (p) => {
    if (typeof p !== "string" && !(p instanceof URL)) return null;
    const abs = resolve(p instanceof URL ? fileURLToPath(p) : p);
    return abs === home || abs.startsWith(`${home}/`) ? abs : null;
  };
  for (const name of ["readFileSync", "readFile", "openSync", "open", "createReadStream", "copyFileSync", "cpSync", "readdirSync", "readdir"]) {
    const real = fs[name];
    fs[name] = function spied(...a) {
      const abs = under(a[0]);
      if (abs !== null) {
        append(log, `${name} ${abs}\n`);
        throw new Error(`read spy: ${name} under the fake real home refused`);
      }
      return real.apply(this, a);
    };
  }
  for (const name of ["readFile", "open", "copyFile", "cp", "readdir"]) {
    const real = fs.promises[name];
    fs.promises[name] = async function spied(...a) {
      const abs = under(a[0]);
      if (abs !== null) {
        append(log, `promises.${name} ${abs}\n`);
        throw new Error(`read spy: promises.${name} under the fake real home refused`);
      }
      return real.apply(this, a);
    };
  }
  syncBuiltinESMExports();
}
