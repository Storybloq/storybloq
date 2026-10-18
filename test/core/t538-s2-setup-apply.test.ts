/**
 * T-538 S2 commit 4: the setup engine (plan v5 1a-1f, 3, 6). One call takes an
 * approved payload to a finished, reported setup; an interruption at any
 * write leaves a setup that the same call finishes from the ledger alone.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject, outsideProjectLock, withBootstrapLock, withProjectLock } from "../../src/core/project-loader.js";
import { setupApply, setupApplySeams } from "../../src/core/setup-apply.js";
import { parseSetupPayload, type SetupPayload } from "../../src/core/setup-payload.js";
import { computeInitialStages } from "../../src/core/verification-activation.js";
import { handleTicketCreate, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { parseSetupMeta } from "../../src/core/setup-meta.js";

const SID = "SS-0123abcd";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-apply-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(async () => {
  setupApplySeams.fault = () => {};
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "t538-apply-"));
  dirs.push(d);
  return d;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: false,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [
      { key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" },
      { key: "K6", id: "polish", name: "Polish", label: "POLISH", description: "" },
    ],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K6", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [{ key: "K5", title: "Imported", body: "b", labels: ["bug"], source: 7 }],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] }],
    ...over,
  };
}

const keyOf = (item: object) => {
  const meta = parseSetupMeta("ticket", item);
  return meta.kind === "item" ? meta.meta.key : null;
};

/** What setup owns, by key, independent of ids, dates and digests that carry time. */
async function ownedView(root: string) {
  const { state } = await loadProject(root);
  const byId = new Map(state.tickets.map((t) => [t.id, keyOf(t)]));
  const config = state.config as typeof state.config & { recipeOverrides?: { stages?: unknown } };
  return {
    phases: state.roadmap.phases.map((p) => [p.id, p.name, p.label, p.description]),
    tickets: state.tickets.map((t) => ({
      key: keyOf(t), title: t.title, type: t.type, phase: t.phase, description: t.description,
      blockedBy: t.blockedBy.map((b) => byId.get(b)).sort(),
      checkpoint: (t as { ownerCheckpoint?: { kind: string; criteria?: string } }).ownerCheckpoint?.criteria ?? null,
      mode: (t as { checkpointEvidenceMode?: string }).checkpointEvidenceMode ?? null,
    })).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    issues: state.issues.map((i) => ({ key: keyOf(i), title: i.title, impact: i.impact, components: i.components })),
    notes: state.notes.map((n) => ({ status: n.status, setup: (n as { setup?: unknown }).setup })),
    stages: config.recipeOverrides?.stages,
    schema: state.config.schemaVersion,
    governance: await readFile(join(root, "CLAUDE.md"), "utf-8").catch(() => null),
    handovers: state.handoverFilenames.length,
  };
}

async function progressPayload(root: string, status: "active" | "archived"): Promise<SetupPayload> {
  const { state } = await loadProject(root);
  const note = state.notes.find((n) => n.status === status && parseSetupMeta("note", n).kind === "record" && (n as { setup?: { record?: string } }).setup?.record === "progress");
  return parseSetupPayload(note!.content);
}

function faultAt(point: string): void {
  let fired = false;
  setupApplySeams.fault = (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Error(`injected fault at ${p}`);
    }
  };
}

describe("a fresh folder", () => {
  it("applies the whole package and reports it, exit 0", async () => {
    const root = await folder();
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe(`Setup applied: ${SID}`);
    expect(result.lines).toContain('-> storybloq · phase "Build" created (K1)');
    expect(result.lines).toContain('-> storybloq · ticket T-001 "Sign in" created (K2)');
    expect(result.lines).toContain('-> storybloq · checkpoint T-003 "Accept sign in" created (acceptance, owner Sam, K4)');
    expect(result.lines).toContain('-> storybloq · issue ISS-001 "Imported" created (K5)');
    expect(result.lines).toContain("-> storybloq · T-002 wired: blocked by T-001, T-003");
    expect(result.lines).toContain("First story: T-001 \"Sign in\"");

    const view = await ownedView(root);
    expect(view.phases).toEqual([["build", "Build", "BUILD", "the first version"], ["polish", "Polish", "POLISH", ""]]);
    expect(view.tickets).toEqual([
      { key: "K2", title: "Sign in", type: "feature", phase: "build", description: "d", blockedBy: [], checkpoint: null, mode: null },
      { key: "K3", title: "Profile", type: "feature", phase: "polish", description: "d", blockedBy: ["K2", "K4"], checkpoint: null, mode: null },
      { key: "K4", title: "Accept sign in", type: "task", phase: "build", description: "", blockedBy: ["K2"], checkpoint: "works", mode: "immutable" },
    ]);
    expect(view.issues).toEqual([{ key: "K5", title: "Imported", impact: "b\n\nImported from GitHub issue #7.", components: ["bug"] }]);
    expect(view.schema).toBe(5);
    expect(view.stages).toEqual(computeInitialStages({ level: "full", verifyApplies: false, components: (payload().quality as SetupPayload["quality"]).components }).stages);
    expect(view.governance).toBe("# demo\n");
    expect(await readFile(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\n");
    expect(existsSync(join(root, ".story", ".setup-bootstrap.json"))).toBe(false);
    expect((await readdir(join(root, ".story", "snapshots"))).length).toBe(1);
  });

  it("archives the progress note last, with one receipt per step, and keeps the frozen records", async () => {
    const root = await folder();
    await setupApply(root, payload());
    const done = await progressPayload(root, "archived");
    const steps = done.receipts.map((r) => r.step);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps.at(-1)).toBe("archive");
    expect(steps).toEqual([
      "enable", "phase:K1", "phase:K6", "item:K2", "item:K3", "item:K4", "item:K5", "wire:K3", "wire:K4",
      "config", "governance:CLAUDE.md", "gitignore", "freeze", "setup-note", "handover", "validate", "snapshot", "archive",
    ]);
    for (const r of done.receipts.slice(steps.indexOf("freeze"))) expect(r.revision).toBe(done.frozen!.revision);
    const { state } = await loadProject(root);
    const final = state.notes.find((n) => (n as { setup?: { record?: string } }).setup?.record === "final")!;
    expect(final.status).toBe("active");
    expect(final.content).toBe(done.frozen!.setupNote);
    expect(final.content).toContain("- R1 (brief): sign in -> K2, K4");
    const handover = await readFile(join(root, done.frozen!.handover.path), "utf-8");
    expect(handover.split("\n")[0]).toBe(`Setup record: ${SID} handover`);
    expect(handover).toBe(done.frozen!.handover.content);
    expect(state.setupInProgress).toEqual([]);
  });

  it("initializes git when the package says so", async () => {
    const root = await folder();
    const result = await setupApply(root, payload({ git: { init: true, gitignore: [] } }));
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(result.lines).toContain(`-> git · repository initialized at ${root}`);
  });

  it("run again after completion, returns the frozen report with nothing written", async () => {
    const root = await folder();
    const first = await setupApply(root, payload());
    const before = await ownedView(root);
    const again = await setupApply(root, payload());
    expect(again.exitCode).toBe(0);
    expect(again.lines.at(-1)).toBe(`Setup applied: ${SID} (already complete; nothing written)`);
    expect(again.lines.slice(0, -1).join("\n")).toBe((await progressPayload(root, "archived")).frozen!.historicalReport);
    expect(first.lines.join("\n")).toContain(again.lines[0]!);
    expect(await ownedView(root)).toEqual(before);
  });
});

describe("refusals before any write", () => {
  it("an invalid payload is exit 2 and creates nothing", async () => {
    const root = await folder();
    const result = await setupApply(root, payload({ tickets: [{ key: "K2", title: "x", type: "feature", phase: "K9", description: "", blockedBy: [] }] }));
    expect(result.exitCode).toBe(2);
    expect(result.lines[0]).toMatch(/^Setup refused: .*K9/);
    expect(existsSync(join(root, ".story"))).toBe(false);
  });

  it("a new payload carrying receipts is exit 2", async () => {
    const root = await folder();
    const result = await setupApply(root, payload({ receipts: [{ step: "config", target: "config", ownedPre: null, ownedPost: "a".repeat(64) }] }));
    expect(result.exitCode).toBe(2);
    expect(existsSync(join(root, ".story"))).toBe(false);
  });

  it("a folder that already holds a project is exit 2 and keeps it as it was", async () => {
    const root = await folder();
    await initProject(root, { name: "mine" });
    await handleTicketCreate({ title: "mine", type: "task", phase: undefined, description: "", blockedBy: [], parentTicket: null }, "json", root);
    const before = await ownedView(root);
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(2);
    expect(result.lines.at(-1)).toMatch(/already holds a project/);
    expect(await ownedView(root)).toEqual(before);
  });
});

describe("an empty scaffold", () => {
  it("is reused: its config and roadmap are kept as pre-images before the first change", async () => {
    const root = await folder();
    await initProject(root, { name: "scaffold" });
    const config = await readFile(join(root, ".story", "config.json"), "utf-8");
    const roadmap = await readFile(join(root, ".story", "roadmap.json"), "utf-8");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(0);
    const done = await progressPayload(root, "archived");
    expect(done.preImages).toEqual([{ target: ".story/config.json", content: config }, { target: ".story/roadmap.json", content: roadmap }]);
    const view = await ownedView(root);
    expect(view.phases.map((p) => p[0])).toEqual(["p0", "build", "polish"]);
    expect(view.schema).toBe(5);
  });
});

describe("bootstrap (plan v5 1b)", () => {
  it("interrupted before publish, the folder is a setup being bootstrapped, which the loader and init refuse; the same call finishes it", async () => {
    const root = await folder();
    faultAt("bootstrap:owned:config.json");
    const stopped = await setupApply(root, payload());
    expect(stopped.exitCode).toBe(3);
    expect(stopped.lines.at(-1)).toMatch(/Resume with storybloq setup-apply --resume --setup SS-0123abcd/);
    expect(existsSync(join(root, ".story", "config.json"))).toBe(false);
    await expect(loadProject(root)).rejects.toMatchObject({ code: "setup_bootstrapping", message: expect.stringMatching(/Setup SS-0123abcd is bootstrapping.*--resume --setup SS-0123abcd/) });
    await expect(initProject(root, { name: "other" })).rejects.toThrow(/already exists/);

    const reference = await folder();
    await setupApply(reference, payload());
    setupApplySeams.fault = () => {};
    expect((await setupApply(root, payload())).exitCode).toBe(0);
    expect(await ownedView(root)).toEqual(await ownedView(reference));
    expect(existsSync(join(root, ".story", ".setup-bootstrap.json"))).toBe(false);
  });

  it.each([
    "bootstrap:manifest", "bootstrap:owned:roadmap.json", "bootstrap:create:roadmap.json", "bootstrap:create:notes/N-001.json",
    "bootstrap:publish", "bootstrap:manifest-removed",
  ])("interrupted at %s, the same call finishes to the same ledger", async (point) => {
    const reference = await folder();
    await setupApply(reference, payload());
    const root = await folder();
    faultAt(point);
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    expect((await setupApply(root, payload())).exitCode).toBe(0);
    expect(await ownedView(root)).toEqual(await ownedView(reference));
  });

  it("published but not yet cleaned up, the project loads, is not an empty scaffold, and lists the setup in progress", async () => {
    const root = await folder();
    faultAt("bootstrap:publish");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    expect(existsSync(join(root, ".story", ".setup-bootstrap.json"))).toBe(true);
    const { state } = await loadProject(root);
    expect(state.isEmptyScaffold).toBe(false);
    expect(state.setupInProgress).toEqual([{ setupId: SID, noteId: "N-001" }]);
  });

  it("a manifest of another setup is reported and never touched", async () => {
    const root = await folder();
    faultAt("bootstrap:owned:config.json");
    await setupApply(root, payload({ setupId: "SS-ffff0000" }));
    const manifest = await readFile(join(root, ".story", ".setup-bootstrap.json"), "utf-8");
    setupApplySeams.fault = () => {};
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: bootstrap manifest of another setup · .* · resolutions: resume SS-ffff0000 \| remove it by hand \| stop$/));
    expect(await readFile(join(root, ".story", ".setup-bootstrap.json"), "utf-8")).toBe(manifest);
  });

  it("a config.json someone else created during bootstrap is kept, and the clash is the owner's", async () => {
    const root = await folder();
    faultAt("bootstrap:owned:config.json");
    await setupApply(root, payload());
    const theirs = JSON.stringify({ version: 2, schemaVersion: 2, project: "theirs", type: "generic", language: "unknown", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }, null, 2) + "\n";
    await writeFile(join(root, ".story", "config.json"), theirs);
    setupApplySeams.fault = () => {};
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: project initialized by someone else during setup/));
    expect(await readFile(join(root, ".story", "config.json"), "utf-8")).toBe(theirs);
  });

  it("a bootstrap target holding someone else's bytes is the owner's, and is kept", async () => {
    const root = await folder();
    faultAt("bootstrap:owned:roadmap.json");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    await writeFile(join(root, ".story", "roadmap.json"), "{}\n");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: bootstrap target occupied · \.story\/roadmap\.json/));
    expect(await readFile(join(root, ".story", "roadmap.json"), "utf-8")).toBe("{}\n");
    expect(existsSync(join(root, ".story", "config.json"))).toBe(false);
  });

  it("a busy lock is exit 7 and writes nothing", async () => {
    const root = await folder();
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    const holder = outsideProjectLock(() => withBootstrapLock(root, async () => { holding(); await released; }));
    await held;
    const result = await setupApply(root, payload(), { lockDeadlineMs: 300 });
    release();
    await holder;
    expect(result.exitCode).toBe(7);
    expect(result.lines.at(-1)).toMatch(/project lock is busy/);
    expect(existsSync(join(root, ".story", ".setup-bootstrap.json"))).toBe(false);
    expect(existsSync(join(root, ".story", "config.json"))).toBe(false);
  });
});

describe("steps resume from their receipts", () => {
  it.each([
    "progress", "step:enable", "step:phase:K1", "step:item:K2", "step:item:K4", "step:item:K5", "step:wire:K3", "step:config",
    "governance-created:CLAUDE.md", "step:governance:CLAUDE.md", "step:gitignore", "step:freeze", "step:setup-note",
    "handover-created", "step:handover", "step:validate", "step:snapshot", "archive-gated",
  ])("interrupted at %s, the same call finishes with every step done once", async (point) => {
    const reference = await folder();
    await initProject(reference, { name: "scaffold" });
    await setupApply(reference, payload());
    const root = await folder();
    await initProject(root, { name: "scaffold" });
    faultAt(point);
    const stopped = await setupApply(root, payload());
    expect(stopped.exitCode).toBe(3);
    expect((await loadProject(root)).state.setupInProgress).toEqual([{ setupId: SID, noteId: "N-001" }]);
    const finished = await setupApply(root, payload());
    expect(finished.exitCode).toBe(0);
    const view = await ownedView(root);
    const ref = await ownedView(reference);
    // A snapshot taken before the fault and one after can both exist; everything setup owns is equal.
    expect(view).toEqual(ref);
    const steps = (await progressPayload(root, "archived")).receipts.map((r) => r.step);
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("an edge the owner added before wiring is kept beside setup's", async () => {
    const root = await folder();
    faultAt("step:item:K5");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    await handleTicketCreate({ title: "owner's", type: "task", phase: "build", description: "", blockedBy: [], parentTicket: null }, "json", root);
    await handleTicketUpdate("T-002", { blockedBy: ["T-004"] }, "json", root);
    expect((await setupApply(root, payload())).exitCode).toBe(0);
    const { state } = await loadProject(root);
    expect([...state.ticketByID("T-002")!.blockedBy].sort()).toEqual(["T-001", "T-003", "T-004"]);
  });

  it("an item carrying a setup key with no create receipt stops as corrupted state and nothing is created for that key", async () => {
    const root = await folder();
    faultAt("step:item:K2");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    const planted = { id: "T-009", title: "planted", description: "", type: "task", status: "open", phase: "build", order: 90, createdDate: "2026-10-18", completedDate: null, blockedBy: [], parentTicket: null, setup: { setupId: SID, key: "K3" } };
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify(planted, null, 2) + "\n");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: corrupted receipt state · K3 \(T-009\)/));
    expect((await loadProject(root)).state.tickets.filter((t) => keyOf(t) === "K3").map((t) => t.id)).toEqual(["T-009"]);
  });

  it.each([
    ["the handover", async (root: string, frozen: NonNullable<SetupPayload["frozen"]>) => writeFile(join(root, frozen.handover.path), "edited\n"), /the handover is not the frozen one/],
    ["the setup note", async (root: string) => {
      const { state } = await loadProject(root);
      const note = state.notes.find((n) => (n as { setup?: { record?: string } }).setup?.record === "final")!;
      const path = join(root, ".story", "notes", `${note.id}.json`);
      const raw = JSON.parse(await readFile(path, "utf-8")) as { content: string };
      raw.content = "edited";
      await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
    }, /the setup note is not the frozen one/],
  ] as const)("the gate refuses to archive when %s is not the frozen bytes, and the setup stays in progress", async (_name, edit, reason) => {
    const root = await folder();
    faultAt("step:snapshot");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    await edit(root, (await progressPayload(root, "active")).frozen!);
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(3);
    expect(result.lines.at(-1)).toMatch(reason);
    expect((await loadProject(root)).state.setupInProgress).toHaveLength(1);
  });

  it("a different package for the setup in progress is the owner's to resolve", async () => {
    const root = await folder();
    faultAt("step:phase:K1");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    const result = await setupApply(root, payload({ ownerLabel: "Alex" }));
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: payload differs from the setup in progress/));
  });
});

describe("files the user owns are never replaced (plan v5 1f)", () => {
  it("a governance file with other bytes stops at exit 4, keeps the user's bytes, and leaves setup's version beside it", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# mine\n");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: user-owned target occupied · CLAUDE\.md · .* · resolutions: keep-current \| stop$/));
    expect(await readFile(join(root, "CLAUDE.md"), "utf-8")).toBe("# mine\n");
    expect(await readFile(join(root, `CLAUDE.md.storybloq-${SID}.proposed`), "utf-8")).toBe("# demo\n");
  });

  it("a governance file already holding setup's bytes is done", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain("-> file · CLAUDE.md already present with setup's content (7 chars)");
  });

  it("a .gitignore missing setup's entries is a pointer edit owed, with the approved result proposed", async () => {
    const root = await folder();
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: pointer edit owed · \.gitignore · observed missing node_modules\//));
    expect(await readFile(join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(await readFile(join(root, `.gitignore.storybloq-${SID}.proposed`), "utf-8")).toBe("dist/\nnode_modules/\n");
  });

  it("a frozen handover path moved out of .story/handovers is refused at the write boundary", async () => {
    const root = await folder();
    faultAt("step:freeze");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const note = state.notes.find((n) => (n as { setup?: { record?: string } }).setup?.record === "progress")!;
      const path = join(root, ".story", "notes", `${note.id}.json`);
      const raw = JSON.parse(await readFile(path, "utf-8")) as { content: string };
      raw.content = raw.content.replace(/"path": "\.story\/handovers\/[^"]+"/, '"path": "docs/handover.md"');
      await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
    });
    await mkdir(join(root, "docs"), { recursive: true });
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: corrupted receipt state · docs\/handover\.md/));
    expect(existsSync(join(root, "docs", "handover.md"))).toBe(false);
  });
});

describe("status names a setup in progress", () => {
  it("in full JSON and in markdown (the compact key list is pinned in status-roster)", async () => {
    const root = await folder();
    faultAt("step:config");
    await setupApply(root, payload());
    setupApplySeams.fault = () => {};
    const { state } = await loadProject(root);
    const { formatStatus } = await import("../../src/core/output-formatter.js");
    expect(JSON.parse(formatStatus(state, "json")).data.setupInProgress).toEqual([{ setupId: SID, noteId: "N-001" }]);
    expect(formatStatus(state, "md")).toContain(`Setup ${SID} is in progress (progress note N-001); resume it with \`storybloq setup-apply --resume --setup ${SID}\`.`);
  });
});
