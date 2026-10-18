/**
 * ISS-1270: the deliberate override, through the built CLI. A fresh benchmark
 * cell sets only CLAUDE_CONFIG_DIR and keeps HOME, so an ordinary command's
 * housekeeping (here the T-534 settings retirement, which runs on any command
 * without the global-install check) must rewrite the override's settings.json
 * and leave HOME's byte-identical. This is also what proves the test suite's
 * CLAUDE_CONFIG_DIR scrub cannot hide a regression: the variable is set here on
 * purpose, through the fixture's explicit override.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

let fixture: E2ECliFixture;

const SEEDED = JSON.stringify({
  hooks: {
    StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: "storybloq session limit-stop" }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "third-party-tool notify" }] }],
  },
}, null, 2);

function seed(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, SEEDED);
  return path;
}

beforeEach(async () => {
  fixture = await E2ECliFixture.create();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("an ordinary command under CLAUDE_CONFIG_DIR (ISS-1270)", () => {
  it("rewrites the override's settings.json and leaves HOME's byte-identical", () => {
    const homeSettings = seed(join(fixture.home, ".claude"));
    const cfg = join(fixture.root, "cfg");
    const cfgSettings = seed(cfg);

    const r = runE2ECli(fixture, ["status"], { env: { CLAUDE_CONFIG_DIR: cfg } });

    const rewritten = readFileSync(cfgSettings, "utf-8");
    expect(rewritten, r.stderr).not.toContain("limit-stop");
    expect(rewritten).toContain("third-party-tool notify");
    expect(readFileSync(homeSettings, "utf-8")).toBe(SEEDED);
  });

  it("without the override the same command rewrites HOME's settings.json", () => {
    const homeSettings = seed(join(fixture.home, ".claude"));
    const r = runE2ECli(fixture, ["status"]);
    expect(readFileSync(homeSettings, "utf-8"), r.stderr).not.toContain("limit-stop");
  });
});
