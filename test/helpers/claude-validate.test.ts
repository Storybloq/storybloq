/**
 * ISS-1408: the validate helper's failure names the claude that ran, its
 * version and what validate printed. A shim claude first on PATH stands in for
 * the real one, so no real client runs here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeValidate } from "./claude-validate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shim(validateExit: number): { bin: string; env: NodeJS.ProcessEnv } {
  const bin = mkdtempSync(join(tmpdir(), "claude-shim-"));
  dirs.push(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Shim Code)"; exit 0; fi\necho "SHIM-STDOUT-LINE"\necho "SHIM-STDERR-LINE" >&2\nexit ${validateExit}\n`,
    { mode: 0o755 },
  );
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

describe("claudeValidate (ISS-1408)", () => {
  it("returns validate's stdout when it passes", () => {
    const { env } = shim(0);
    expect(claudeValidate("/nowhere", env)).toBe("SHIM-STDOUT-LINE\n");
  });

  it("on failure names the resolved claude, its version, the exit and both streams", () => {
    const { bin, env } = shim(1);
    let message = "";
    try {
      claudeValidate("/nowhere", env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("claude plugin validate /nowhere failed (exit 1)");
    expect(message).toContain(`claude: ${join(bin, "claude")}`);
    expect(message).toContain("version: 9.9.9 (Shim Code)");
    expect(message).toContain("stdout:\nSHIM-STDOUT-LINE");
    expect(message).toContain("stderr:\nSHIM-STDERR-LINE");
  });
});
