/**
 * T-486 U1-3 through the built CLI: `merge-driver --capabilities` answers for
 * protocols 4 and 5 and an omitted one, and refuses an unsupported one with
 * the same predicate the merge path uses (A8-2); and a checkpoint-enabled
 * team ledger merges through the command setup registers, for v4 and for v5
 * (CK5): the checkpoint merge cases, clean and divergent, on records the
 * lifecycle wrote, plus a blockedBy union. The registered command runs
 * `storybloq` from PATH, so each merge puts a shim for the built CLI first
 * on PATH; nothing reaches the machine's installed binary. Needs a current
 * dist/cli.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";
import { git as fixtureGit, gitAllowFailure } from "../helpers/git-fixture.js";
import { initProject } from "../../src/core/init.js";
import { MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME, effectiveMergeDriver, teamSetup } from "../../src/core/team-setup.js";
import { enableCheckpoints } from "../../src/core/checkpoint-enable.js";
import { mergeDriverCapabilities } from "../../src/cli/commands/merge-driver.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { createCheckpoint, resolveCheckpoint, retireCheckpoint, type ExpectedCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";

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
  type Json = Record<string, unknown>;
  const ACTOR = "owner@example.test";
  const TICKET = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: null, order: 10,
    createdDate: "2026-10-04", completedDate: null, blockedBy: [], parentTicket: null, ...over,
  });

  /** A team ledger set up and checkpoint-enabled by this build, its tickets merged by `driver`. */
  async function ledger(driver: string) {
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

    const shim = temp("t486-ck5-bin-");
    writeFileSync(join(shim, "storybloq"), `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`, { mode: 0o755 });
    /** Commit `base` on main, `ours` on branch ours and `theirs` on branch theirs, then merge theirs into ours through the registered driver. */
    async function merge(base: () => Promise<void>, ours: () => Promise<void>, theirs: () => Promise<void>) {
      await base();
      g("add", "-A");
      g("commit", "-q", "-m", "base");
      g("checkout", "-q", "-b", "theirs");
      await theirs();
      g("add", "-A");
      g("commit", "-q", "-m", "theirs");
      g("checkout", "-q", "main");
      g("checkout", "-q", "-b", "ours");
      await ours();
      g("add", "-A");
      g("commit", "-q", "-m", "ours");
      return gitAllowFailure(repo, ["merge", "--no-edit", "theirs"], {
        env: { GIT_MERGE_AUTOEDIT: "no", PATH: `${shim}:${process.env.PATH ?? ""}`, HOME: fixture.home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" },
      });
    }
    return { repo, g, merge };
  }

  const write = (path: string, body: object) => writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as Json;
  function expectedOf(t: object): ExpectedCheckpoint {
    const p = parseOwnerCheckpoint(t);
    if (p.kind !== "ok") throw new Error("not a readable checkpoint");
    return { generation: p.checkpoint.generation, revision: p.checkpoint.revision, digest: p.checkpoint.digest };
  }

  /**
   * One checkpoint: created on main, then each branch runs a real lifecycle
   * write (`approve`, `retire`) or a plain edit. With `evidence`, the record
   * also carries evidence on an upstream checkpoint that each side changes
   * differently, as in the resolve tests. Returns the merge run and the
   * record each side committed.
   */
  async function checkpointMerge(driver: string, ours: Side, theirs: Side, opts: { evidence?: boolean } = {}) {
    const { repo, merge } = await ledger(driver);
    let path = "";
    let id = "";
    const sides: { base?: Json; ours?: Json; theirs?: Json } = {};
    let upstream: { id: string; revision: number; digest: string } | null = null;
    const evidence = (state: string, generation: number) => upstream ? [{ checkpoint: upstream.id, generation, revision: upstream.revision, digest: upstream.digest, state }] : undefined;
    const apply = (side: Side, generation: number) => async () => {
      const before = readJson(path);
      if (side === "approve") await resolveCheckpoint(repo, id, expectedOf(before), { response: "yes", actor: ACTOR });
      else if (side === "retire") await retireCheckpoint(repo, id, expectedOf(before), "dropped", ACTOR);
      else if (side === "retitle") write(path, { ...before, title: "retitled" });
      else write(path, { ...before, description: "edited" });
      if (upstream && (side === "approve" || side === "retire")) write(path, { ...readJson(path), checkpointEvidence: evidence(side === "approve" ? "approved" : "retired", generation) });
    };
    const run = await merge(async () => {
      if (opts.evidence) {
        const up = await createCheckpoint(repo, { title: "Upstream", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Upstream?", evidenceRefs: [] }, actor: ACTOR });
        const e = expectedOf(up);
        upstream = { id: up.id, revision: e.revision, digest: e.digest };
      }
      const t = await createCheckpoint(repo, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
      id = t.id;
      path = join(repo, ".story", "tickets", `${id}.json`);
      if (upstream) write(path, { ...readJson(path), checkpointEvidence: evidence("approved", 1) });
      sides.base = readJson(path);
    }, async () => {
      await apply(ours, 2)();
      sides.ours = readJson(path);
    }, async () => {
      await apply(theirs, 3)();
      sides.theirs = readJson(path);
    });
    return { run, path, base: sides.base!, ours: sides.ours!, theirs: sides.theirs! };
  }
  type Side = "approve" | "retire" | "retitle" | "edit";

  const DRIVERS = [MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME];
  const CLEAN: [string, Side, Side, (o: Json, t: Json) => Json][] = [
    ["ours approves, theirs retitles", "approve", "retitle", (o, t) => ({ ...o, title: t.title })],
    ["ours retitles, theirs approves", "retitle", "approve", (o, t) => ({ ...t, title: o.title })],
    ["ours retires, theirs edits the description", "retire", "edit", (o, t) => ({ ...o, description: t.description })],
  ];
  const cleanCells = DRIVERS.flatMap((d) => CLEAN.map(([name, ours, theirs, expected]) => [d, name, ours, theirs, expected] as const));

  it.each(cleanCells)("%s, clean: %s; the merged record carries the checkpoint", async (driver, _name, ours, theirs, expected) => {
    const r = await checkpointMerge(driver, ours, theirs);
    expect(r.run.status, r.run.stdout + r.run.stderr).toBe(0);
    const merged = readJson(r.path);
    expect(merged).toEqual(expected(r.ours, r.theirs));
    expect(merged.ownerCheckpoint).toEqual((ours === "approve" || ours === "retire" ? r.ours : r.theirs).ownerCheckpoint);
  });

  const DIVERGENT: [string, Side, Side, boolean][] = [
    ["ours approves, theirs retires", "approve", "retire", false],
    ["ours retires, theirs approves", "retire", "approve", false],
    ["ours approves, theirs retires, each changing the evidence", "approve", "retire", true],
  ];
  const divergentCells = DRIVERS.flatMap((d) => DIVERGENT.map(([name, ours, theirs, ev]) => [d, name, ours, theirs, ev] as const));

  it.each(divergentCells)("%s, divergent: %s; git records the conflict and the file keeps both sides' checkpoint and evidence", async (driver, _name, ours, theirs, ev) => {
    const r = await checkpointMerge(driver, ours, theirs, { evidence: ev });
    expect(r.run.status, r.run.stdout + r.run.stderr).not.toBe(0);
    const merged = readJson(r.path);
    const conflicts = (merged._conflicts ?? []) as Json[];
    const group = conflicts.filter((c) => c.group === "ticket-status");
    expect(group.length, JSON.stringify(conflicts)).toBeGreaterThan(0);
    const kept = JSON.stringify(group);
    for (const side of [r.ours, r.theirs]) {
      expect(kept).toContain(JSON.stringify(side.ownerCheckpoint));
      if (ev) expect(kept).toContain(JSON.stringify(side.checkpointEvidence));
    }
    if (ev) expect(r.ours.checkpointEvidence).not.toEqual(r.theirs.checkpointEvidence);
  });

  it.each(DRIVERS)("%s: a two-sided blockedBy change merges by union, which a text merge cannot", async (driver) => {
    const { repo, merge } = await ledger(driver);
    const ticketPath = join(repo, ".story", "tickets", "T-001.json");
    const run = await merge(async () => {
      for (const id of ["T-002", "T-003"]) write(join(repo, ".story", "tickets", `${id}.json`), TICKET(id));
      write(ticketPath, TICKET("T-001"));
    }, async () => write(ticketPath, TICKET("T-001", { blockedBy: ["T-003"] })), async () => write(ticketPath, TICKET("T-001", { blockedBy: ["T-002"] })));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect((readJson(ticketPath).blockedBy as string[]).sort()).toEqual(["T-002", "T-003"]);
  });
});
