/**
 * T-534 Step 0 + Part A through the built CLI on an isolated HOME: the first
 * ordinary command retires the usage-limit auto-resume, and later commands
 * (including the `session limit-stop` tombstone and the read-only
 * `limit-status`) never recreate a hook, the ledger, `wake-claims/`, the lock
 * files or the config member.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

let fixture: E2ECliFixture;
let settingsPath: string;

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
}

interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
}

const readSettings = (): Settings => JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings;
const allCommands = (s: Settings): string[] =>
  Object.values(s.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

function seed(): void {
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  settingsPath = join(fixture.home, ".claude", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    model: "opus",
    hooks: {
      StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: "storybloq session limit-stop" }] }],
      SessionStart: [
        { matcher: "resume", hooks: [{ type: "command", command: "storybloq session resume-prompt" }] },
        { matcher: "compact", hooks: [{ type: "command", command: "storybloq session resume-prompt" }] },
      ],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "third-party-tool notify" }] }],
    },
  }, null, 2));

  const g = fixture.globalDir;
  writeFileSync(join(g, "config.json"), JSON.stringify({ limitResume: { enabled: true }, other: { keep: true } }));
  writeFileSync(join(g, "limit-ledger.json"), JSON.stringify({
    schemaVersion: 1,
    records: {
      "claude:t1": {
        clientTaskId: "t1",
        projectRoot: join(fixture.root, "gone-project"),
        storybloqSessionId: "s1",
        attempt: { id: "a1", childPid: deadPid() },
      },
    },
  }));
  mkdirSync(join(g, "wake-claims"), { recursive: true });
  writeFileSync(join(g, "wake-claims", "t1.json"), JSON.stringify({ taskId: "t1" }));
}

function expectRetired(): void {
  const g = fixture.globalDir;
  const commands = allCommands(readSettings());
  expect(commands.some((c) => c.includes("limit-stop"))).toBe(false);
  expect((readSettings().hooks?.SessionStart ?? []).find((grp) => grp.matcher === "resume")).toBeUndefined();
  expect(commands).toContain("third-party-tool notify");
  // The compact group stays (the sweep may canonicalise its binary path).
  expect((readSettings().hooks?.SessionStart ?? []).some((grp) =>
    grp.matcher === "compact" && grp.hooks.some((h) => h.command.endsWith("session resume-prompt")))).toBe(true);
  expect(existsSync(join(g, "limit-ledger.json"))).toBe(false);
  expect(existsSync(join(g, "wake-claims"))).toBe(false);
  expect(existsSync(join(g, "waker.lock"))).toBe(false);
  expect(existsSync(join(g, "limit-ledger.lock"))).toBe(false);
  const config = JSON.parse(readFileSync(join(g, "config.json"), "utf-8")) as Record<string, unknown>;
  expect(config.limitResume).toBeUndefined();
  expect(config.other).toEqual({ keep: true });
  expect(existsSync(join(g, ".limit-retired-v1"))).toBe(true);
}

beforeEach(async () => {
  fixture = await E2ECliFixture.create();
  seed();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("usage-limit retirement on upgrade (T-534)", () => {
  it("retires on the first ordinary command and nothing recreates the runtime afterwards", () => {
    runE2ECli(fixture, ["status"]);
    expectRetired();
    const marker = readFileSync(join(fixture.globalDir, ".limit-retired-v1"), "utf-8");

    const stop = runE2ECli(fixture, ["session", "limit-stop"], {
      input: JSON.stringify({ session_id: "t2", cwd: fixture.root, error_type: "rate_limit", hook_event_name: "StopFailure" }),
    });
    expect(stop.status).toBe(0);

    const status = runE2ECli(fixture, ["limit-status"]);
    expect(status.status).toBe(0);
    const cancel = runE2ECli(fixture, ["limit-status", "--cancel", "claude:t1"]);
    expect(cancel.stdout + cancel.stderr).toContain("retired");

    runE2ECli(fixture, ["status"]);
    expectRetired();
    expect(readFileSync(join(fixture.globalDir, ".limit-retired-v1"), "utf-8")).toBe(marker);
  });

  it("the tombstone alone completes the retirement on a HOME no other command has touched", () => {
    const stop = runE2ECli(fixture, ["session", "limit-stop"], {
      input: JSON.stringify({ session_id: "t2", cwd: fixture.root, error_type: "rate_limit", hook_event_name: "StopFailure" }),
    });
    expect(stop.status).toBe(0);
    expectRetired();
  });
});
