import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { TicketSchema } from "../../src/models/ticket.js";
import { E2ECliFixture, runE2ECli, CLI_PATH } from "../helpers/e2e-cli.js";

const cliPath = CLI_PATH;
const driverCmd = `node ${cliPath} merge-driver %O %A %B %P`;

// ISS-1091: isolated HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME for
// direct `cli()` invocations. `merge-driver` itself is explicitly in
// housekeeping's skip list (shouldSkipHousekeeping), so the driver invocation
// git launches internally during a merge is not part of this fix's scope --
// only the direct cli()/`conflicts`/`resolve`/`ticket` calls this file makes.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

function createTeamRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-e2e-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "merge.storybloq-json.driver", driverCmd], { cwd: dir });
  execFileSync("git", ["config", "merge.storybloq-json.name", "Storybloq JSON three-way merge"], { cwd: dir });
  const storyDir = join(dir, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  writeFileSync(
    join(storyDir, ".gitattributes"),
    "tickets/*.json merge=storybloq-json\nconfig.json merge=storybloq-json\nroadmap.json merge=storybloq-json\n",
  );
  writeFileSync(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, project: "test", type: "npm", language: "ts",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      team: { enabled: true },
    }, null, 2) + "\n",
  );
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({
      title: "test", date: "2026-01-01",
      phases: [
        { id: "p1", label: "P1", name: "Phase 1", description: "First." },
        { id: "p2", label: "P2", name: "Phase 2", description: "Second." },
        { id: "p3", label: "P3", name: "Phase 3", description: "Third." },
      ],
      blockers: [],
    }, null, 2) + "\n",
  );
  return dir;
}

// Returns stdout only (fix direction d) on both the success and failure path.
function cli(dir: string, ...args: string[]): { exitCode: number; stdout: string } {
  const result = runE2ECli(fixture, args, { cwd: dir });
  return { exitCode: result.status ?? 1, stdout: result.stdout };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } }).trim();
}

function gitMerge(dir: string, branch: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync("git", ["merge", "--no-edit", branch], { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { exitCode: e.status ?? 1, output: e.stdout ?? "" };
  }
}

function writeTicket(dir: string, id: string, overrides: Record<string, unknown> = {}): void {
  const ticket = {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open",
    phase: "p1", order: 10, createdDate: "2026-01-01", completedDate: null,
    blockedBy: [], parentTicket: null, ...overrides,
  };
  writeFileSync(join(dir, ".story", "tickets", `${id}.json`), JSON.stringify(ticket, null, 2) + "\n");
}

const tmpDirs: string[] = [];
afterEach(() => { tmpDirs.length = 0; });

describe("G-2: end-to-end git merge driver", () => {
  it("clean merge: one-sided title change through actual git merge", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: "Title From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "Base Title", description: "Added by B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(merged.title).toBe("Title From A");
    expect(merged.description).toBe("Added by B");
    expect(merged._conflicts).toBeUndefined();
  });

  it("conflict merge: both sides change title, _conflicts emitted", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: "Title From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "Title From B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(Array.isArray(merged._conflicts)).toBe(true);
    expect(merged._conflicts.length).toBeGreaterThan(0);
    expect(merged._conflicts[0].field).toBe("title");
  });

  it("commutative merge: both sides add different blockers", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { blockedBy: ["T-010"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { blockedBy: ["T-010", "T-020"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add blocker on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { blockedBy: ["T-010", "T-030"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add blocker on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(merged._conflicts).toBeUndefined();
    const sortedBlockers = [...merged.blockedBy].sort();
    expect(sortedBlockers).toEqual(["T-010", "T-020", "T-030"]);
  });

  it("config.json merge through git", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    const cfgA = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgA.language = "python";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgA, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change language on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    const cfgB = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgB.project = "renamed";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgB, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change project on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    expect(merged.language).toBe("python");
    expect(merged.project).toBe("renamed");
  });

  it("add/add: independently created entity with no common ancestor auto-resolves via driver", () => {
    // Regression for the empty-%O bug: an add/add has no merge base, so git
    // passes an empty ancestor file. The driver must treat that as base {} and
    // still merge (here a commutative blockedBy union) rather than bailing to a
    // raw `CONFLICT (add/add)`.
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base (no T-002)");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-002", { blockedBy: ["T-010", "T-020"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-002", { blockedBy: ["T-010", "T-030"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const raw = readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8");
    expect(raw).not.toContain("<<<<<<<");
    const merged = JSON.parse(raw);
    expect(merged._conflicts).toBeUndefined();
    expect([...merged.blockedBy].sort()).toEqual(["T-010", "T-020", "T-030"]);
    expect(exitCode).toBe(0);
  });

  it("add/add: divergent entity sharing an id surfaces structured _conflicts, not raw markers", () => {
    // Two branches independently create T-002 with different content (the
    // displayId-collision shape). Before the empty-%O fix this surfaced as a
    // raw git add/add conflict; now the driver writes a structured _conflicts
    // block the user can resolve.
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base (no T-002)");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-002", { title: "From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-002", { title: "From B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const raw = readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8");
    expect(raw).not.toContain("<<<<<<<");
    const merged = JSON.parse(raw);
    expect(Array.isArray(merged._conflicts)).toBe(true);
    expect(merged._conflicts.some((c: { field: string }) => c.field === "title")).toBe(true);
    // Structured conflict must still leave the merge unresolved (git exit 1).
    expect(exitCode).toBe(1);

    // ISS-747: the merged file must stay loadable (title kept in the body),
    // visible to conflicts list, and resolvable via the documented command.
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    expect(merged.title).toBeDefined();
    const list = cli(dir, "conflicts", "list");
    expect(list.stdout).toContain("T-002");
    expect(list.stdout).not.toContain("No conflicts found");
    const res = cli(dir, "resolve", "T-002", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
    // Merging branch-a into branch-b: ours = "From B", theirs = "From A".
    expect(resolved.title).toBe("From A");
    expect(resolved._conflicts).toBeUndefined();
  });

  function setupTombstoneAddAdd(): string {
    const tombstone = {
      lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com",
    };
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base (no T-002)");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-002", { title: "Fresh add" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create active T-002 on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-002", tombstone);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create tombstoned T-002 on B");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).toBe(1);

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
    // Never again a file containing only {"_conflicts": [...]}.
    expect(merged.id).toBe("T-002");
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    return dir;
  }

  it("ISS-747 tombstone add/add variant resolves toward the tombstone (--use ours)", () => {
    const dir = setupTombstoneAddAdd();
    const res = cli(dir, "resolve", "T-002", "--use", "ours"); // ours = branch-b's tombstone
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
    expect(resolved._conflicts).toBeUndefined();
    expect(resolved.lifecycle).toBe("deleted");
    expect(resolved.deletedAt).toBe("2026-05-26T00:00:00Z");
  }, 20000);

  it("ISS-747 tombstone add/add variant resolves toward the active entity (--use theirs)", () => {
    const dir = setupTombstoneAddAdd();
    const res = cli(dir, "resolve", "T-002", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
    expect(resolved._conflicts).toBeUndefined();
    expect(resolved.title).toBe("Fresh add");
    expect(resolved.lifecycle).not.toBe("deleted");
  }, 20000);
});

describe("ISS-746: delete-vs-edit end-to-end recovery loop", () => {
  function setupDeleteEditRepo(): string {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { description: "original desc" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "edit");
    writeTicket(dir, "T-001", { description: "edited by teammate" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "edit description");

    git(dir, "checkout", "main");
    writeTicket(dir, "T-001", {
      description: "original desc",
      lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "tombstone T-001");
    return dir;
  }

  it("--use theirs restores the edit, lifts the gate, leaves no junk key", () => {
    const dir = setupDeleteEditRepo();
    const { exitCode } = gitMerge(dir, "edit");
    expect(exitCode).toBe(1);

    // The merged file stays loadable and visible.
    const get = cli(dir, "ticket", "get", "T-001");
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toContain("T-001");
    const list = cli(dir, "conflicts", "list");
    expect(list.stdout).toContain("T-001");

    const res = cli(dir, "resolve", "T-001", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(resolved.description).toBe("edited by teammate");
    expect(resolved.lifecycle).not.toBe("deleted");
    expect(resolved._entity).toBeUndefined();
    expect(resolved._conflicts).toBeUndefined();

    // Write gate lifted.
    const update = cli(dir, "ticket", "update", "T-001", "--title", "Post-resolve update");
    expect(update.exitCode).toBe(0);
  }, 20000);

  it("--use ours applies the tombstone with the deleting side's original stamps", () => {
    const dir = setupDeleteEditRepo();
    gitMerge(dir, "edit");

    const res = cli(dir, "resolve", "T-001", "--use", "ours");
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(resolved.lifecycle).toBe("deleted");
    expect(resolved.deletedAt).toBe("2026-05-26T00:00:00Z");
    expect(resolved.deletedBy).toBe("alice@test.com");
    expect(resolved._conflicts).toBeUndefined();
  }, 20000);
});

describe("ISS-749: config/roadmap conflicts are showable and resolvable", () => {
  it("config divergence: conflicts show config.json renders, resolve config lifts the gate", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    const cfgA = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgA.project = "renamed-a";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgA, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "rename on A");

    git(dir, "checkout", "main");
    const cfgM = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgM.project = "renamed-main";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgM, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "rename on main");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).toBe(1);

    const show = cli(dir, "conflicts", "show", "config.json");
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("/project");

    const res = cli(dir, "resolve", "config", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    expect(cfg.project).toBe("renamed-a");
    expect(cfg._conflicts).toBeUndefined();

    // Gate lifted: a write now succeeds.
    const create = cli(dir, "ticket", "create", "--title", "post-resolve", "--type", "task");
    expect(create.exitCode).toBe(0);
  });

  it("roadmap nested-phase divergence resolves via --field", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    const rmA = JSON.parse(readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"));
    rmA.phases[0].name = "Alpha Branch";
    writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify(rmA, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "rename phase on A");

    git(dir, "checkout", "main");
    const rmM = JSON.parse(readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"));
    rmM.phases[0].name = "Alpha Main";
    writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify(rmM, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "rename phase on main");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).toBe(1);

    const res = cli(dir, "resolve", "roadmap", "--field", "/phases/0/name", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const rm = JSON.parse(readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"));
    expect(rm.phases[0].name).toBe("Alpha Branch");
    expect(rm._conflicts).toBeUndefined();
  });

  it("reorder loop: resolve roadmap --use theirs applies theirs' order over merged content", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    const readRm = () => JSON.parse(readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"));
    const writeRm = (rm: Record<string, unknown>) =>
      writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify(rm, null, 2) + "\n");

    git(dir, "checkout", "-b", "branch-a");
    const rmA = readRm();
    rmA.phases = [rmA.phases[1], rmA.phases[2], rmA.phases[0]]; // [p2, p3, p1]
    writeRm(rmA);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "reorder on A");

    git(dir, "checkout", "main");
    const rmM = readRm();
    rmM.phases = [rmM.phases[2], rmM.phases[0], rmM.phases[1]]; // [p3, p1, p2]
    rmM.phases[1].description = "edited on main";
    writeRm(rmM);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "reorder + edit on main");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).toBe(1);

    const res = cli(dir, "resolve", "roadmap", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const rm = readRm();
    expect((rm.phases as Array<Record<string, unknown>>).map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    const p1 = (rm.phases as Array<Record<string, unknown>>).find((p) => p.id === "p1")!;
    expect(p1.description).toBe("edited on main"); // element CONTENT preserved
  });
});

describe("ISS-750: carried conflicts neither resurrect nor drop", () => {
  it("resolved conflicts do not resurrect from the merge base on a later unrelated merge", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Original" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "From B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "title on B");

    git(dir, "checkout", "main");
    writeTicket(dir, "T-001", { title: "From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "title on main");

    // Conflicted merge, committed with its _conflicts block (merge commit M).
    const first = gitMerge(dir, "branch-b");
    expect(first.exitCode).toBe(1);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "merge M with conflicts");

    // A teammate branches from M and makes an unrelated edit, keeping the block.
    git(dir, "checkout", "-b", "branch-c");
    const carried = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    carried.description = "unrelated edit";
    writeFileSync(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(carried, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "unrelated edit on C");

    // Main resolves the conflict.
    git(dir, "checkout", "main");
    const res = cli(dir, "resolve", "T-001", "--use", "ours");
    expect(res.exitCode).toBe(0);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "resolve on main");

    // The later merge must NOT resurrect the resolved entry.
    const second = gitMerge(dir, "branch-c");
    expect(second.exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(merged._conflicts).toBeUndefined();
    expect(merged.description).toBe("unrelated edit");
  });

  it("committed unresolved config conflicts survive an unrelated second merge and stay write-blocking until resolved", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    const readCfg = () => JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    const writeCfg = (cfg: Record<string, unknown>) =>
      writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfg, null, 2) + "\n");

    git(dir, "checkout", "-b", "branch-b");
    const cfgB = readCfg();
    cfgB.project = "gamma";
    writeCfg(cfgB);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "project on B");

    git(dir, "checkout", "main");
    const cfgM = readCfg();
    cfgM.project = "beta";
    writeCfg(cfgM);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "project on main");

    const first = gitMerge(dir, "branch-b");
    expect(first.exitCode).toBe(1);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "merge M with config conflicts");

    // Both lines carry the unresolved block and make unrelated edits.
    git(dir, "checkout", "-b", "branch-c");
    const cfgC = readCfg();
    cfgC.language = "python";
    writeCfg(cfgC);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "language on C");

    git(dir, "checkout", "main");
    const cfgM2 = readCfg();
    cfgM2.type = "cargo";
    writeCfg(cfgM2);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "type on main");

    const second = gitMerge(dir, "branch-c");
    expect(second.exitCode).toBe(0); // carried-only merges exit 0 by design

    const merged = readCfg();
    expect(Array.isArray(merged._conflicts)).toBe(true);
    expect(merged.language).toBe("python");
    expect(merged.type).toBe("cargo");

    // Still write-blocked.
    const blocked = cli(dir, "ticket", "create", "--title", "x", "--type", "task");
    expect(blocked.exitCode).not.toBe(0);

    // Resolution clears it and lifts the gate.
    const res = cli(dir, "resolve", "config", "--use", "ours");
    expect(res.exitCode).toBe(0);
    const resolved = readCfg();
    expect(resolved.project).toBe("beta");
    expect(resolved._conflicts).toBeUndefined();
    const create = cli(dir, "ticket", "create", "--title", "x", "--type", "task");
    expect(create.exitCode).toBe(0);
  });
});

describe("R8: self-heal of pre-existing ISS-747 damage", () => {
  it("re-merging a _conflicts-only damaged file heals through the fallback ladder", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    const legacyEntry = { fieldPath: "", field: "_entity", kind: "delete-edit", base: "active", ours: "deleted", theirs: "edited" };
    const damagedPath = join(dir, ".story", "tickets", "T-003.json");
    writeFileSync(damagedPath, JSON.stringify({ _conflicts: [legacyEntry] }, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base with damaged T-003");

    git(dir, "checkout", "-b", "restore");
    writeTicket(dir, "T-003", { title: "Restored" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "restore T-003 on branch");

    git(dir, "checkout", "main");
    writeFileSync(damagedPath, JSON.stringify({ _conflicts: [legacyEntry], title: 123 }, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "still-damaged edit on main");

    const { exitCode } = gitMerge(dir, "restore");
    expect(exitCode).toBe(1);

    const merged = JSON.parse(readFileSync(damagedPath, "utf-8"));
    expect(merged.id).toBe("T-003");
    expect(merged.title).toBe("Restored");
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    const entityEntry = (merged._conflicts as Array<Record<string, unknown>>).find((c) => c.field === "_entity" && typeof c.ours === "object");
    expect(entityEntry).toBeDefined();
    expect((entityEntry!.theirs as Record<string, unknown>).title).toBe("Restored");
  });
});

describe("ISS-770: theirs-sourced malformed carried _conflicts", () => {
  it("ours valid + theirs carrying a malformed entry: output loads, malformed dropped, valid carried, exit 1", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    // theirs (branch-a): same body as ours, but carries one well-formed and one
    // malformed _conflicts entry (the malformed one fails ConflictEntrySchema).
    git(dir, "checkout", "-b", "branch-a");
    const wellFormed = { fieldPath: "/order", field: "order", kind: "field", base: 10, ours: 20, theirs: 30 };
    const malformed = { fieldPath: "/desc", field: "desc", kind: "totally-invalid-kind", base: "a", ours: "b", theirs: "c" };
    writeTicket(dir, "T-001", { title: "Shared Title", _conflicts: [wellFormed, malformed] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "carry conflicts on A");

    // ours (branch-b): identical body, NO _conflicts.
    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "Shared Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "no conflicts on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    // The written file must load under the loader's schema.
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    const entries = (merged._conflicts ?? []) as Array<Record<string, unknown>>;
    // The theirs-sourced malformed entry must not survive into the output.
    expect(entries.some((c) => c.kind === "totally-invalid-kind")).toBe(false);
    // The well-formed carried entry survives.
    expect(entries.some((c) => c.field === "order")).toBe(true);
    // Conflicts present -> merge stays unresolved (git exit 1).
    expect(exitCode).toBe(1);
  });

  it("ours ALREADY invalid + merged body ours-equal: pass-through exemption preserved, exit 0", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title", description: "orig" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    // theirs (branch-a): title made a number (schema-invalid), description unchanged.
    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: 123, description: "orig" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "invalid title on A");

    // ours (branch-b): same invalid title, description edited so ours body wins.
    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: 123, description: "ours-desc" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "invalid title + desc on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    // Pre-existing-broken ours passes through unchanged (no _entity fallback added).
    expect(merged.title).toBe(123);
    expect(merged.description).toBe("ours-desc");
    expect(merged._conflicts).toBeUndefined();
    expect(TicketSchema.safeParse(merged).success).toBe(false);
    expect(exitCode).toBe(0);
  });
});

describe("ISS-786: identical concurrent claims release without a schema-breaking null", () => {
  it("both branches claim T-001 with identical claim.since: clean merge, no claim key, loads", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { claim: null, claimedBySession: null });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", {
      claim: { user: "alice@test.com", branch: "feat/a", since: "2026-05-25T10:00:00Z" },
      claimedBySession: "sess-a",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "claim on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", {
      claim: { user: "bob@test.com", branch: "feat/b", since: "2026-05-25T10:00:00Z" },
      claimedBySession: "sess-b",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "claim on B");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).toBe(0);

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    // The released claim is key-ABSENT, so the file loads and there is no blocking conflict.
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    expect(merged._conflicts).toBeUndefined();
    expect(Object.hasOwn(merged, "claim")).toBe(false);
    expect(Object.hasOwn(merged, "claimedBySession")).toBe(false);
  });
});

describe("ISS-787: both-tombstoned merge surfaces divergent pre-delete content", () => {
  function setupDivergentTombstones(): string {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    // theirs (edit-delete): edit the title THEN tombstone.
    git(dir, "checkout", "-b", "edit-delete");
    writeTicket(dir, "T-001", {
      title: "Edited Title",
      lifecycle: "deleted", deletedAt: "2026-05-26T01:00:00Z", deletedBy: "bob@test.com",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "edit + tombstone on theirs");

    // ours (main): tombstone only, title unchanged.
    git(dir, "checkout", "main");
    writeTicket(dir, "T-001", {
      title: "Base Title",
      lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "tombstone on ours");
    return dir;
  }

  it("theirs edited-then-deleted vs ours deleted: git exit 1, ours tombstone kept, edit in the conflict", () => {
    const dir = setupDivergentTombstones();
    const { exitCode } = gitMerge(dir, "edit-delete");
    expect(exitCode).toBe(1);

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    // ours' tombstone kept wholesale as the body.
    expect(merged.lifecycle).toBe("deleted");
    expect(merged.title).toBe("Base Title");
    expect(merged.deletedBy).toBe("alice@test.com");
    expect(TicketSchema.safeParse(merged).success).toBe(true);

    const entry = (merged._conflicts as Array<Record<string, unknown>>)[0];
    expect(entry.kind).toBe("delete-edit");
    expect(entry.field).toBe("_entity");
    expect((entry.theirs as Record<string, unknown>).title).toBe("Edited Title");
  });

  it("resolve --use theirs restores theirs' edited tombstone body", () => {
    const dir = setupDivergentTombstones();
    const { exitCode } = gitMerge(dir, "edit-delete");
    expect(exitCode).toBe(1);

    const list = cli(dir, "conflicts", "list");
    expect(list.stdout).toContain("T-001");
    expect(list.stdout).not.toContain("No conflicts found");

    const res = cli(dir, "resolve", "T-001", "--use", "theirs");
    expect(res.exitCode).toBe(0);
    const resolved = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(resolved.title).toBe("Edited Title");
    expect(resolved.lifecycle).toBe("deleted");
    expect(resolved._conflicts).toBeUndefined();
  }, 20000);
});

describe("I5: non-team repos never invoke the driver", () => {
  it("a repo without the merge driver gets git's default conflict markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-e2e-plain-"));
    tmpDirs.push(dir);
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    mkdirSync(join(dir, ".story", "tickets"), { recursive: true });
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: "Title From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "A");

    git(dir, "checkout", "main");
    writeTicket(dir, "T-001", { title: "Title From Main" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "main");

    const { exitCode } = gitMerge(dir, "branch-a");
    expect(exitCode).not.toBe(0);
    const raw = readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8");
    expect(raw).toContain("<<<<<<<");
  });
});
