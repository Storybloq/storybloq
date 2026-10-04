/**
 * T-486 U1-3 through the built CLI: `merge-driver --capabilities` answers for
 * protocols 4 and 5 and an omitted one, and refuses an unsupported one with
 * the same predicate the merge path uses (A8-2); and a checkpoint-enabled
 * team ledger merges through the command setup registers, for v4 and for v5
 * (CK5). The registered command runs `storybloq` from PATH, so each merge
 * puts a shim for the built CLI first on PATH; nothing reaches the
 * machine's installed binary. Needs a current dist/cli.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";
import { git as fixtureGit, gitAllowFailure } from "../helpers/git-fixture.js";
import { initProject } from "../../src/core/init.js";
import { MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME, effectiveMergeDriver, teamSetup } from "../../src/core/team-setup.js";
import { enableCheckpoints } from "../../src/core/checkpoint-enable.js";
import { mergeDriverCapabilities } from "../../src/cli/commands/merge-driver.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";

let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const cli = (...args: string[]) => spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8", env: fixture.env(), timeout: 60_000 });

describe("merge-driver --capabilities through the CLI (A8-2)", () => {
  it.each([4, 5])("protocol %i answers with checkpoints", (protocol) => {
    const r = cli("merge-driver", "--protocol", String(protocol), "--capabilities");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual(mergeDriverCapabilities(protocol));
    expect(JSON.parse(r.stdout.trim()).checkpoints).toBe(true);
  });

  it("an omitted protocol answers for the current one", () => {
    const r = cli("merge-driver", "--capabilities");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ protocol: 5, maxSchemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpoints: true });
  });

  it("an unsupported protocol is refused, naming what this build serves and team setup", () => {
    const r = cli("merge-driver", "--protocol", "6", "--capabilities");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("protocol 6 is not supported by this build (supports 4 and 5); update storybloq, then run storybloq team setup");
  });
});

describe("a checkpoint-enabled team ledger merges through the registered command (CK5)", () => {
  const TICKET = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: null, order: 10,
    createdDate: "2026-10-04", completedDate: null, blockedBy: [], parentTicket: null, ...over,
  });

  it.each([MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME])("%s: a two-sided blockedBy change merges by union, which a text merge cannot", async (driver) => {
    const repo = temp("t486-ck5-");
    const g = (...args: string[]) => fixtureGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { env: { GIT_MERGE_AUTOEDIT: "no" } });
    g("init", "-q", "-b", "main");
    await initProject(repo, { name: "t486" });
    const configPath = join(repo, ".story", "config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf-8")), team: { enabled: true } }, null, 2) + "\n");
    await teamSetup(repo);
    if (driver === MERGE_DRIVER_V4_NAME) {
      const info = join(repo, g("rev-parse", "--git-path", "info/attributes"));
      writeFileSync(info, readFileSync(info, "utf-8").replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, `merge=${MERGE_DRIVER_V4_NAME}`));
    }
    await enableCheckpoints(repo, { capabilities: async (_root, protocol) => mergeDriverCapabilities(protocol) });
    expect(effectiveMergeDriver(repo, ".story/tickets/T-001.json")).toBe(driver);

    const ticketPath = join(repo, ".story", "tickets", "T-001.json");
    const write = (path: string, body: object) => writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
    for (const id of ["T-002", "T-003"]) write(join(repo, ".story", "tickets", `${id}.json`), TICKET(id));
    write(ticketPath, TICKET("T-001"));
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "a");
    write(ticketPath, TICKET("T-001", { blockedBy: ["T-002"] }));
    g("commit", "-q", "-am", "a");
    g("checkout", "-q", "main");
    g("checkout", "-q", "-b", "b");
    write(ticketPath, TICKET("T-001", { blockedBy: ["T-003"] }));
    g("commit", "-q", "-am", "b");

    const shim = temp("t486-ck5-bin-");
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "storybloq"), `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`, { mode: 0o755 });
    const merged = gitAllowFailure(repo, ["merge", "--no-edit", "a"], {
      env: { GIT_MERGE_AUTOEDIT: "no", PATH: `${shim}:${process.env.PATH ?? ""}`, HOME: fixture.home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" },
    });
    expect(merged.status, merged.stdout + merged.stderr).toBe(0);
    expect((JSON.parse(readFileSync(ticketPath, "utf-8")).blockedBy as string[]).sort()).toEqual(["T-002", "T-003"]);
  });
});
