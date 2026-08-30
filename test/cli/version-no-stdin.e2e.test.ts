/**
 * ISS-1043: the CLI must never touch process.stdin at ESM link time.
 *
 * tsup bundles with splitting: false, which inlines the lazy --mcp branch of
 * src/cli/index.ts into dist/cli.js and hoists its external imports to top
 * level. A static import of the SDK's server/stdio.js there makes Node's
 * builtin facade eagerly read every export of node:process at link time --
 * including the stdin getter, which constructs the stdin TTY (kernel open() of
 * the controlling terminal) on EVERY invocation, --version included, before
 * argv parsing. On a wedged pty that open() hangs uninterruptibly.
 *
 * This probe is a runtime spawn against the BUILT bundle, because that is
 * where the defect lives: the source's dynamic-import guard is correct and an
 * AST check (the presence-wiring technique) cannot see the hoist. The poison
 * replaces the stdin getter before the bundle links; any touch writes a
 * sentinel to stderr. Getter poisoning is fd-type-independent, so this is
 * deterministic with or without a tty. It also catches any FUTURE external
 * dep that starts importing node:process at module scope.
 *
 * Runs against dist/cli.js, so `npm run build` must have produced a current
 * bundle.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";

vi.setConfig({ testTimeout: 60_000 });

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = CLI_PATH;

// ISS-1091: this suite's poisoned --import must stay the ONLY thing injected
// into the child's module graph, so the spawn call itself stays verbatim;
// only the env source is swapped to the shared fixture's isolated
// HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME, which is what stops
// --version's unconditional preCommandHousekeeping pass from touching the
// real ~/.claude/skills.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

const SENTINEL = "STDIN-TOUCHED";

// Restore-and-delegate: record the touch, then hand back the real stdin so a
// command that legitimately reads it later still works.
const POISON = `
const d = Object.getOwnPropertyDescriptor(process, "stdin");
Object.defineProperty(process, "stdin", {
  configurable: true,
  get() {
    console.error("${SENTINEL}\\n" + new Error().stack);
    Object.defineProperty(process, "stdin", d);
    return d.get ? d.get.call(process) : d.value;
  },
});
`;

function runPoisoned(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "node",
      ["--import", `data:text/javascript,${encodeURIComponent(POISON)}`, cliPath, ...args],
      { cwd, stdio: ["pipe", "pipe", "pipe"], env: fixture.env() },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      fixture.recordResult({ stdout, stderr });
      resolvePromise({ code, stdout, stderr });
    });
    // Close stdin so a command that DOES read it terminates instead of hanging.
    proc.stdin.end();
  });
}

describe("CLI never touches process.stdin at link time (ISS-1043)", () => {
  it("dist/cli.js exists (run npm run build before this suite)", () => {
    expect(existsSync(cliPath), "dist/cli.js is missing. Run npm run build before this suite.").toBe(true);
  });

  it("--version prints the version without touching stdin", async () => {
    const { code, stdout, stderr } = await runPoisoned(["--version"], pkgRoot);
    expect(stderr, `stdin was touched at link time:\n${stderr}`).not.toContain(SENTINEL);
    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("an ordinary command does not touch stdin at link time either", async () => {
    // `--help` exercises the full CLI wiring (yargs, command registry) without
    // needing a .story/ project; link-time is identical for every command.
    const { stderr } = await runPoisoned(["--help"], pkgRoot);
    expect(stderr, `stdin was touched at link time:\n${stderr}`).not.toContain(SENTINEL);
  });
});
