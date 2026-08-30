import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

/**
 * T-442, end to end through the real CLI.
 *
 * The unit tests cover `clearClaimOnComplete` directly, which is exactly why they
 * did not catch the defect this file exists for: the guard's rejection message
 * told the caller to "re-run with --force", but `--force` was never registered on
 * `ticket update`, so the documented escape hatch did not exist. A guard whose
 * only exit is unreachable is worse than no guard -- it strands the operator.
 *
 * Runs against the BUILT bundle, so `npm run build` must have produced a current
 * dist/cli.js.
 */

vi.setConfig({ testTimeout: 60_000 });

// ISS-1091: isolated HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

// Returns stdout only (fix direction d) on both the success and failure path.
function cli(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { ok: result.status === 0, out: result.stdout };
}

function ticketPath(root: string): string {
  const dir = join(root, ".story", "tickets");
  const file = readdirSync(dir).find((f) => f.endsWith(".json"));
  if (!file) throw new Error("no ticket file");
  return join(dir, file);
}

function claimedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t442-guard-"));
  cli(dir, "init", "--name", "guard", "--type", "npm");
  cli(dir, "ticket", "create", "--title", "Claimed work", "--type", "feature");

  // Stamp the ticket the way an autonomous session does: BOTH ownership fields,
  // with no live session record backing them, which is the orphaned-stamp case.
  const path = ticketPath(dir);
  const ticket = JSON.parse(readFileSync(path, "utf-8"));
  ticket.status = "inprogress";
  ticket.claimedBySession = "2b53d2fd-8f92-4cb4-b459-1df54474adc7";
  ticket.claim = { user: "someone@example.com", branch: "main", since: "2026-07-28T09:00:00.000Z" };
  writeFileSync(path, JSON.stringify(ticket, null, 2));
  return dir;
}

describe("ticket completion guard, end to end (T-442)", () => {
  it("refuses to complete a claimed ticket and leaves it byte-identical", () => {
    const dir = claimedProject();
    const path = ticketPath(dir);
    const before = readFileSync(path, "utf-8");

    const result = cli(dir, "ticket", "update", "T-001", "--status", "complete");

    expect(result.ok).toBe(false);
    expect(result.out).toContain("cannot prove ownership");
    // A rejected completion must not half-apply: the status stays put and both
    // ownership fields survive.
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("offers a --force escape hatch that actually exists and completes the ticket", () => {
    const dir = claimedProject();
    const path = ticketPath(dir);

    const rejected = cli(dir, "ticket", "update", "T-001", "--status", "complete");
    expect(rejected.out).toContain("--force");

    // The regression: the message advertised a flag yargs did not register, so
    // this failed with "Unknown argument: force" rather than completing.
    const forced = cli(dir, "ticket", "update", "T-001", "--status", "complete", "--force");
    expect(forced.ok).toBe(true);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.status).toBe("complete");
    expect("claim" in after).toBe(false);
    expect("claimedBySession" in after).toBe(false);
  });

  it("does not gate an unclaimed ticket", () => {
    const dir = mkdtempSync(join(tmpdir(), "t442-open-"));
    cli(dir, "init", "--name", "open", "--type", "npm");
    cli(dir, "ticket", "create", "--title", "Unclaimed", "--type", "feature");

    const result = cli(dir, "ticket", "update", "T-001", "--status", "complete");
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(ticketPath(dir), "utf-8")).status).toBe("complete");
  });
});
