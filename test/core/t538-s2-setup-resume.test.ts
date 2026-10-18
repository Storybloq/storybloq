/**
 * T-538 S2 commit 5: resuming a setup (plan v5 1d, 2, 6a, 6b). A resume
 * classifies every entity setup wrote against its last receipt before it
 * writes again; anything the owner changed in between is an ambiguity with
 * its resolutions, `--resolve` records the owner's choice, and an amendment
 * after the freeze brings finalization to the new revision without
 * replacing a file the user owns.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import {
  effectiveRevision,
  setupApply,
  setupApplySeams,
  setupHandoverPath,
  setupResolve,
  setupResume,
} from "../../src/core/setup-apply.js";
import { parseSetupPayload, validateSetupPayload, type SetupPayload } from "../../src/core/setup-payload.js";
import { setupPaths } from "../../src/core/setup-review.js";
import { handleTicketCreate, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { parseSetupMeta } from "../../src/core/setup-meta.js";

const SID = "SS-0123abcd";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let reviewDir: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-resume-home-"));
  reviewDir = join(scratchHome, "review-store");
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
  await rm(reviewDir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "t538-resume-"));
  dirs.push(d);
  return d;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Independent review: approve, invocation SR-00000001, revision 000000000000"] },
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

function faultAt(point: string): void {
  let fired = false;
  setupApplySeams.fault = (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Error(`injected fault at ${p}`);
    }
  };
}

/** A setup interrupted at `point`, with the fault seam cleared. */
async function stoppedAt(point: string, over: Record<string, unknown> = {}, scaffold = false): Promise<string> {
  const root = await folder();
  if (scaffold) await initProject(root, { name: "scaffold" });
  faultAt(point);
  const result = await setupApply(root, payload(over));
  expect(result.exitCode).toBe(3);
  setupApplySeams.fault = () => {};
  return root;
}

async function progressPayload(root: string, status: "active" | "archived"): Promise<SetupPayload> {
  const { state } = await loadProject(root);
  const note = state.notes.find((n) => n.status === status && (n as { setup?: { record?: string } }).setup?.record === "progress");
  return parseSetupPayload(note!.content);
}

async function editJson(path: string, edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
}

const configPath = (root: string) => join(root, ".story", "config.json");
const env = () => ({ ...process.env, STORYBLOQ_SETUP_REVIEW_DIR: reviewDir });

/** The review store for this setup: a recorded skip, or a completed review of `packet`. */
async function reviewStore(root: string, how: { skipped: true } | { packet: string }): Promise<string | null> {
  const paths = setupPaths(env(), root, SID);
  await mkdir(paths.dir, { recursive: true });
  const setup = { setupId: SID, projectKey: paths.projectKey, createdAt: "2026-10-18T00:00:00Z", cycle: 2, cycleReasons: {}, probe: null, probedAt: "2026-10-18T00:00:00Z", ...("skipped" in how && { skipped: { at: "2026-10-18T00:00:00Z" } }) };
  await writeFile(paths.setupFile, JSON.stringify(setup));
  if ("skipped" in how) return null;
  const revision = sha(how.packet);
  const dir = join(paths.records, "SR-0000000a");
  await mkdir(dir, { recursive: true });
  const output = JSON.stringify({ verdict: "approve", findings: [] });
  await writeFile(join(dir, "packet.md"), how.packet);
  await writeFile(join(dir, "reviewer-output.json"), output);
  const sections = Object.fromEntries(["Source requirements", "Owner answers and decisions", "Existing-state evidence", "Plan"].map((s) => [s, sha(s)]));
  await writeFile(join(dir, "record.json"), JSON.stringify({
    state: "completed", recordId: "SR-0000000a", setupId: SID, cycle: 2, round: 1, revisionSha256: revision, sectionSha256s: sections,
    backend: "codex", backendVersion: "1", startedAt: "2026-10-18T00:00:00Z", endedAt: "2026-10-18T00:01:00Z", exitCode: 0,
    outputSha256: sha(output), verdict: "approve", findingsCount: 0, reviewerSessionId: null, newCycleReason: "amendment",
  }));
  return revision;
}

const resolve1 = (root: string, target: string, resolution: string, extra: Record<string, unknown> = {}) =>
  setupResolve(root, SID, [{ target, resolution, ownerWords: "the owner said so", ...extra }], { env: env() });

describe("setup-apply --resume --setup <id>", () => {
  it.each([
    "bootstrap:manifest", "bootstrap:owned:roadmap.json", "bootstrap:create:notes/N-001.json", "bootstrap:owned:config.json", "bootstrap:publish",
    "step:enable", "step:item:K4", "step:wire:K3", "step:config", "governance-created:CLAUDE.md", "step:freeze", "handover-created", "step:snapshot", "archive-gated",
  ])("interrupted at %s, resume by id alone finishes the setup", async (point) => {
    const reference = await folder();
    await setupApply(reference, payload());
    const root = await stoppedAt(point);
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe(`Setup applied: ${SID}`);
    const done = await progressPayload(root, "archived");
    expect(done.receipts.at(-1)!.step).toBe("archive");
    const titles = async (r: string) => (await loadProject(r)).state.tickets.map((t) => [keyOf(t), t.title, t.blockedBy.length]).sort();
    expect(await titles(root)).toEqual(await titles(reference));
  });

  it("after completion returns the frozen report with nothing written", async () => {
    const root = await folder();
    await setupApply(root, payload());
    const before = await readFile(join(root, ".story", "notes", "N-001.json"), "utf-8");
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe(`Setup applied: ${SID} (already complete; nothing written)`);
    expect(result.lines).toContain('First story: T-001 "Sign in"');
    expect(await readFile(join(root, ".story", "notes", "N-001.json"), "utf-8")).toBe(before);
  });

  it("refuses an id that is not a setup id, and a setup that is not here, with nothing written", async () => {
    const empty = await folder();
    expect((await setupResume(empty, "nope")).exitCode).toBe(2);
    expect((await setupResume(empty, SID)).lines.at(-1)).toBe(`Setup refused: no setup ${SID} in this folder.`);
    expect(existsSync(join(empty, ".story"))).toBe(false);
    const other = await folder();
    await initProject(other, { name: "x" });
    expect((await setupResume(other, SID)).lines.at(-1)).toBe(`Setup refused: no setup ${SID} in this project.`);
  });

  it("a bootstrap manifest of another setup is reported and kept", async () => {
    const root = await stoppedAt("bootstrap:manifest");
    const result = await setupResume(root, "SS-ffffffff");
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: bootstrap manifest of another setup · \.story\/\.setup-bootstrap\.json · observed setup SS-0123abcd/));
    expect(existsSync(join(root, ".story", ".setup-bootstrap.json"))).toBe(true);
  });

  it("a progress note archived before it finished is a setup set aside, never reported complete", async () => {
    const root = await stoppedAt("step:config");
    await editJson(join(root, ".story", "notes", "N-001.json"), (raw) => { raw.status = "archived"; });
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(2);
    expect(result.lines.at(-1)).toMatch(/was set aside: its progress note was archived before it finished/);
  });
});

describe("edits between sessions are classified before the next write (plan v5 1d)", () => {
  it("an edge the owner added after wiring is kept beside setup's", async () => {
    const root = await stoppedAt("step:wire:K3");
    await handleTicketCreate({ title: "owner's", type: "task", phase: "build", description: "", blockedBy: [], parentTicket: null }, "json", root);
    await handleTicketUpdate("T-002", { blockedBy: ["T-001", "T-003", "T-004"] }, "json", root);
    expect((await setupResume(root, SID)).exitCode).toBe(0);
    expect([...(await loadProject(root)).state.ticketByID("T-002")!.blockedBy].sort()).toEqual(["T-001", "T-003", "T-004"]);
  });

  it("a setup edge removed after wiring stops with its resolutions, and nothing further is written", async () => {
    const root = await stoppedAt("step:wire:K3");
    await handleTicketUpdate("T-002", { blockedBy: ["T-001"] }, "json", root);
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContain("Ambiguity: setup edge removed · T-002 -> T-003 · observed T-002 is no longer blocked by T-003; expected the edge setup wired · resolutions: accept-removal | restore-edge | stop");
    expect((await progressPayload(root, "active")).receipts.some((r) => r.step === "config")).toBe(false);
  });

  it.each([
    ["a ticket description", async (root: string) => { await handleTicketUpdate("T-001", { description: "the owner's words" }, "json", root); },
      "Ambiguity: owned field edited · K2 (T-001) · observed description differ from the plan; expected the values setup wrote · resolutions: accept-current | restore-planned | stop"],
    ["a checkpoint title", async (root: string) => { await handleTicketUpdate("T-003", { title: "Accept it" }, "json", root); },
      "Ambiguity: owned field edited · K4 (T-003) · observed title differ from the plan; expected the values setup wrote · resolutions: accept-current | restore-planned | stop"],
    ["an issue title", async (root: string) => { await handleIssueUpdate("ISS-001", { title: "Renamed" }, "json", root); },
      "Ambiguity: owned field edited · K5 (ISS-001) · observed title differ from the plan; expected the values setup wrote · resolutions: accept-current | restore-planned | stop"],
    ["a phase name", async (root: string) => { await editJson(join(root, ".story", "roadmap.json"), (raw) => { (raw.phases as Array<{ name: string }>)[0]!.name = "Make"; }); },
      "Ambiguity: owned field edited · phase build (K1) · observed name differ from the plan; expected the values setup wrote · resolutions: accept-current | restore-planned | stop"],
  ] as const)("%s edited after its create stops as an owned field edited", async (_name, edit, line) => {
    const root = await stoppedAt("step:config");
    await edit(root);
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContain(line);
  });

  it("a recipe stage changed after the config step stops as config drifted", async () => {
    const root = await stoppedAt("step:governance:CLAUDE.md");
    await editJson(configPath(root), (raw) => { (raw.recipeOverrides as { stages: { TEST: { enabled: boolean } } }).stages.TEST.enabled = false; });
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: config drifted · \.story\/config\.json · .* · resolutions: accept-current \| restore-planned \| stop$/));
  });

  it("a reused scaffold's config changed after its pre-image was recorded stops before the config step", async () => {
    const root = await stoppedAt("step:phase:K1", {}, true);
    await editJson(configPath(root), (raw) => { raw.language = "go"; });
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: config drifted · \.story\/config\.json · observed .*pre-image.* · resolutions: accept-current \| stop$/));
  });

  it("a keyed item deleted after its create stops, with stop as the only resolution", async () => {
    const root = await stoppedAt("step:config");
    await rm(join(root, ".story", "issues", "ISS-001.json"));
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual("Ambiguity: setup item removed · K5 (ISS-001) · observed no item carries K5; expected the item setup created · resolutions: stop");
  });

  it("a key carried by two items (a merge) stops with keep for each", async () => {
    const root = await stoppedAt("step:config");
    const dup = JSON.parse(await readFile(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>;
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify({ ...dup, id: "T-009" }, null, 2) + "\n");
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: key on two items · K2 \(T-001, T-009\) · .* · resolutions: keep T-001 \| keep T-009 \| stop$/));
  });

  it("an unkeyed item with a planned item's title, the planned one absent, offers adopt and replace", async () => {
    const root = await stoppedAt("step:phase:K6");
    await handleTicketCreate({ title: "Sign in", type: "feature", phase: "build", description: "d", blockedBy: [], parentTicket: null }, "json", root);
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: unkeyed item matches a planned item · K2 \(T-001\) · .* · resolutions: adopt T-001 \| replace \| stop$/));
  });

  it("a governance file changed after its receipt, and a .gitignore that lost setup's entry, are drift the owner keeps or stops on", async () => {
    const root = await stoppedAt("step:gitignore");
    await writeFile(join(root, "CLAUDE.md"), "# mine now\n");
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: governance file drifted · CLAUDE\.md · observed bytes setup did not write; .* · resolutions: keep-current \| stop$/));
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: governance file drifted · \.gitignore · observed missing node_modules\/; .* · resolutions: keep-current \| stop$/));
    expect(result.lines.at(-1)).toMatch(/^Setup stopped: the owner must resolve 2 ambiguities\./);
  });

  it("checkpoints on a team ledger below schema 5 stop at enable with drop-checkpoints", async () => {
    const root = await folder();
    await initProject(root, { name: "scaffold" });
    await editJson(configPath(root), (raw) => { raw.team = { enabled: true }; });
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Ambiguity: schema-5 enable refused · \.story\/config\.json · .* · resolutions: drop-checkpoints \| stop$/));
  });
});

describe("--resolve records the owner's choice (plan v5 2a)", () => {
  it("stop writes nothing; a target with no open ambiguity, or a setup that is complete, is refused with nothing written", async () => {
    const root = await stoppedAt("step:config");
    await handleTicketUpdate("T-001", { description: "mine" }, "json", root);
    const before = await readFile(join(root, ".story", "notes", "N-001.json"), "utf-8");
    expect((await resolve1(root, "K2 (T-001)", "stop")).exitCode).toBe(3);
    const wrong = await resolve1(root, "K9 (T-009)", "restore-planned");
    expect(wrong.exitCode).toBe(2);
    expect(wrong.lines.at(-1)).toMatch(/no open ambiguity at K9 \(T-009\) takes restore-planned; open: K2 \(T-001\) \(accept-current \| restore-planned \| stop\)/);
    expect((await setupResolve(root, SID, [{ target: "K2 (T-001)" }])).exitCode).toBe(2);
    expect(await readFile(join(root, ".story", "notes", "N-001.json"), "utf-8")).toBe(before);
    const done = await folder();
    await setupApply(done, payload());
    expect((await resolve1(done, "K2 (T-001)", "restore-planned")).lines.at(-1)).toBe(`Setup refused: setup ${SID} is complete; there is nothing to resolve.`);
  });

  it("restore-planned writes the planned values back, records no amendment, and the setup finishes", async () => {
    const root = await stoppedAt("step:config");
    await handleTicketUpdate("T-001", { description: "mine" }, "json", root);
    const result = await resolve1(root, "K2 (T-001)", "restore-planned");
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain("-> storybloq · resolved K2 (T-001): restore-planned");
    expect((await loadProject(root)).state.ticketByID("T-001")!.description).toBe("d");
    expect((await progressPayload(root, "archived")).amendments).toEqual([]);
  });

  it("accept-current on an owned field is material: refused without a review, accepted with a completed review of the amended packet", async () => {
    const root = await stoppedAt("step:config");
    await handleTicketUpdate("T-001", { description: "mine" }, "json", root);
    const refusedNoStore = await resolve1(root, "K2 (T-001)", "accept-current");
    expect(refusedNoStore.exitCode).toBe(2);
    expect(refusedNoStore.lines.at(-1)).toMatch(/changes the approved package and this setup has no review record; run storybloq setup-review run --new-cycle/);
    const revision = (await reviewStore(root, { packet: "# amended packet\n" }))!;
    const noRevision = await resolve1(root, "K2 (T-001)", "accept-current");
    expect(noRevision.exitCode).toBe(2);
    const unknown = await resolve1(root, "K2 (T-001)", "accept-current", { reviewRevision: sha("another packet") });
    expect(unknown.lines.at(-1)).toMatch(/no completed or round-limit review for revision/);
    expect((await progressPayload(root, "active")).amendments).toEqual([]);
    const ok = await resolve1(root, "K2 (T-001)", "accept-current", { reviewRevision: revision });
    expect(ok.exitCode).toBe(0);
    expect(ok.lines).toContain("-> storybloq · resolved K2 (T-001): accept-current (material, review recorded)");
    const done = await progressPayload(root, "archived");
    expect(done.amendments).toEqual([expect.objectContaining({ class: "owned field edited", target: "K2 (T-001)", resolution: "accept-current", ownerWords: "the owner said so", material: true, reviewRevision: revision })]);
    expect(done.frozen!.revision).toBe(effectiveRevision(done));
    expect((await loadProject(root)).state.ticketByID("T-001")!.description).toBe("mine");
  });

  it("a recorded skip for this setup stands in for the review of a material amendment", async () => {
    const root = await stoppedAt("step:config");
    await handleTicketUpdate("T-001", { description: "mine" }, "json", root);
    await reviewStore(root, { skipped: true });
    expect((await resolve1(root, "K2 (T-001)", "accept-current")).exitCode).toBe(0);
  });

  it("the approved package's own revision is not a review of the amendment", async () => {
    const root = await stoppedAt("step:config");
    await handleTicketUpdate("T-001", { description: "mine" }, "json", root);
    await reviewStore(root, { packet: "# amended\n" });
    const approved = "000000000000" + "0".repeat(52);
    const result = await resolve1(root, "K2 (T-001)", "accept-current", { reviewRevision: approved });
    expect(result.lines.at(-1)).toMatch(/is the approved package's, not the amended one/);
  });

  it("accept-removal drops the edge from the plan (material); restore-edge puts it back", async () => {
    const a = await stoppedAt("step:wire:K3");
    await handleTicketUpdate("T-002", { blockedBy: ["T-001"] }, "json", a);
    await reviewStore(a, { skipped: true });
    expect((await resolve1(a, "T-002 -> T-003", "accept-removal")).exitCode).toBe(0);
    expect((await loadProject(a)).state.ticketByID("T-002")!.blockedBy).toEqual(["T-001"]);
    const done = await progressPayload(a, "archived");
    expect(done.receipts.filter((r) => r.step === "wire:K3").at(-1)!.edges).toEqual([["T-002", "T-001"]]);
    expect(done.amendments[0]).toMatchObject({ resolution: "accept-removal", material: true });

    await rm(reviewDir, { recursive: true, force: true });
    const b = await stoppedAt("step:wire:K3");
    await handleTicketUpdate("T-002", { blockedBy: ["T-001"] }, "json", b);
    expect((await resolve1(b, "T-002 -> T-003", "restore-edge")).exitCode).toBe(0);
    expect([...(await loadProject(b)).state.ticketByID("T-002")!.blockedBy].sort()).toEqual(["T-001", "T-003"]);
    expect((await progressPayload(b, "archived")).amendments).toEqual([]);
  });

  it("keep <id> supersedes the other item's key and leaves its content as it was", async () => {
    const root = await stoppedAt("step:config");
    const dup = JSON.parse(await readFile(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>;
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify({ ...dup, id: "T-009", description: "theirs" }, null, 2) + "\n");
    expect((await resolve1(root, "K2 (T-001, T-009)", "keep T-001")).exitCode).toBe(0);
    const t9 = (await loadProject(root)).state.ticketByID("T-009") as unknown as { setup: unknown; description: string };
    expect(t9.setup).toEqual({ setupId: SID, key: "K2", supersededBy: "T-001" });
    expect(t9.description).toBe("theirs");
  });

  it("adopt stamps the existing item and creates none; replace creates the planned item and leaves the other unkeyed", async () => {
    const a = await stoppedAt("step:phase:K6");
    await handleTicketCreate({ title: "Sign in", type: "feature", phase: "build", description: "d", blockedBy: [], parentTicket: null }, "json", a);
    const adopted = await resolve1(a, "K2 (T-001)", "adopt T-001");
    expect(adopted.exitCode).toBe(0);
    const sa = (await loadProject(a)).state;
    expect(sa.tickets.filter((t) => t.title === "Sign in").map((t) => [t.id, keyOf(t)])).toEqual([["T-001", "K2"]]);
    expect((await progressPayload(a, "archived")).amendments[0]).toMatchObject({ resolution: "adopt T-001", material: false });

    const b = await stoppedAt("step:phase:K6");
    await handleTicketCreate({ title: "Sign in", type: "feature", phase: "build", description: "other", blockedBy: [], parentTicket: null }, "json", b);
    expect((await resolve1(b, "K2 (T-001)", "adopt T-001")).lines.at(-1)).toMatch(/changes the approved package/);
    expect((await resolve1(b, "K2 (T-001)", "replace")).exitCode).toBe(0);
    const sb = (await loadProject(b)).state;
    expect(sb.tickets.filter((t) => t.title === "Sign in").map((t) => [t.id, keyOf(t)]).sort()).toEqual([["T-001", null], ["T-002", "K2"]]);
  });

  it("config: accept-current that keeps the quality level is not material; restore-planned writes the planned stages", async () => {
    const a = await stoppedAt("step:governance:CLAUDE.md");
    await editJson(configPath(a), (raw) => { raw.language = "javascript"; });
    expect((await resolve1(a, ".story/config.json", "accept-current")).exitCode).toBe(0);
    expect((await loadProject(a)).state.config.language).toBe("javascript");
    expect((await progressPayload(a, "archived")).amendments[0]).toMatchObject({ class: "config drifted", material: false });

    const b = await stoppedAt("step:governance:CLAUDE.md");
    await editJson(configPath(b), (raw) => { (raw.recipeOverrides as { stages: { TEST: { enabled: boolean } } }).stages.TEST.enabled = false; });
    expect((await resolve1(b, ".story/config.json", "accept-current")).lines.at(-1)).toMatch(/changes the approved package/);
    expect((await resolve1(b, ".story/config.json", "restore-planned")).exitCode).toBe(0);
    const stages = ((await loadProject(b)).state.config as unknown as { recipeOverrides: { stages: { TEST: { enabled: boolean } } } }).recipeOverrides.stages;
    expect(stages.TEST.enabled).toBe(true);
  });

  it("a scaffold config the owner changed is accepted as the new baseline, and the config step then writes setup's values over it", async () => {
    const root = await stoppedAt("step:phase:K1", {}, true);
    await editJson(configPath(root), (raw) => { raw.language = "go"; });
    expect((await resolve1(root, ".story/config.json", "accept-current")).exitCode).toBe(0);
    expect((await loadProject(root)).state.config.language).toBe("typescript");
  });

  it("keep-current on a governance file setup never wrote is material and removes setup's .proposed copy; on drift it is not", async () => {
    const a = await folder();
    await writeFile(join(a, "CLAUDE.md"), "# mine\n");
    expect((await setupApply(a, payload())).exitCode).toBe(4);
    await reviewStore(a, { skipped: true });
    expect((await resolve1(a, "CLAUDE.md", "keep-current")).exitCode).toBe(0);
    expect(await readFile(join(a, "CLAUDE.md"), "utf-8")).toBe("# mine\n");
    expect(existsSync(join(a, `CLAUDE.md.storybloq-${SID}.proposed`))).toBe(false);
    expect((await progressPayload(a, "archived")).amendments[0]).toMatchObject({ class: "user-owned target occupied", material: true });

    await rm(reviewDir, { recursive: true, force: true });
    const b = await stoppedAt("step:gitignore");
    await writeFile(join(b, "CLAUDE.md"), "# mine now\n");
    expect((await resolve1(b, "CLAUDE.md", "keep-current")).exitCode).toBe(0);
    expect((await progressPayload(b, "archived")).amendments[0]).toMatchObject({ class: "governance file drifted", material: false });
  });

  it("a pointer edit owed: applied is refused until the file lists the entries, then receipted with the .proposed removed; keep-current leaves the file", async () => {
    const a = await folder();
    await writeFile(join(a, ".gitignore"), "dist/\n");
    expect((await setupApply(a, payload())).exitCode).toBe(4);
    expect((await resolve1(a, ".gitignore", "applied")).lines.at(-1)).toBe("Setup refused: .gitignore: applied, but it does not list node_modules/ yet.");
    await writeFile(join(a, ".gitignore"), await readFile(join(a, `.gitignore.storybloq-${SID}.proposed`), "utf-8"));
    expect((await resolve1(a, ".gitignore", "applied")).exitCode).toBe(0);
    expect(existsSync(join(a, `.gitignore.storybloq-${SID}.proposed`))).toBe(false);
    expect((await progressPayload(a, "archived")).amendments).toEqual([]);

    const b = await folder();
    await writeFile(join(b, ".gitignore"), "dist/\n");
    await setupApply(b, payload());
    expect((await resolve1(b, ".gitignore", "keep-current")).exitCode).toBe(0);
    expect(await readFile(join(b, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(existsSync(join(b, `.gitignore.storybloq-${SID}.proposed`))).toBe(false);
  });

  it("drop-checkpoints takes the checkpoints and their gates out of the plan (material)", async () => {
    const root = await folder();
    await initProject(root, { name: "scaffold" });
    await editJson(configPath(root), (raw) => { raw.team = { enabled: true }; });
    await setupApply(root, payload());
    expect((await resolve1(root, ".story/config.json", "drop-checkpoints")).lines.at(-1)).toMatch(/changes the approved package/);
    await reviewStore(root, { skipped: true });
    const result = await resolve1(root, ".story/config.json", "drop-checkpoints");
    expect(result.exitCode).toBe(0);
    const { state } = await loadProject(root);
    expect(state.tickets.filter((t) => (t as { ownerCheckpoint?: unknown }).ownerCheckpoint !== undefined)).toEqual([]);
    const k3 = state.tickets.find((t) => keyOf(t) === "K3")!;
    expect(k3.blockedBy).toEqual([state.tickets.find((t) => keyOf(t) === "K2")!.id]);
    expect(result.lines).toContainEqual(expect.stringMatching(/^Created: 2 phases, 2 tickets, 0 checkpoints, 1 issues$/));
  });

  it("two progress notes for one setup: keep one, the other is archived unfinished", async () => {
    const root = await stoppedAt("step:config");
    const note = JSON.parse(await readFile(join(root, ".story", "notes", "N-001.json"), "utf-8")) as Record<string, unknown>;
    await writeFile(join(root, ".story", "notes", "N-009.json"), JSON.stringify({ ...note, id: "N-009" }, null, 2) + "\n");
    const stopped = await setupResume(root, SID);
    expect(stopped.exitCode).toBe(4);
    expect(stopped.lines).toContainEqual(expect.stringMatching(/^Ambiguity: progress notes · SS-0123abcd · observed 2 active progress notes; expected exactly one · resolutions: keep N-001 \| keep N-009 \| stop$/));
    const kept = await resolve1(root, SID, "keep N-001");
    expect(kept.exitCode).toBe(0);
    expect((await loadProject(root)).state.notes.find((n) => n.id === "N-009")!.status).toBe("archived");
  });
});

describe("an amendment after the freeze (plan v5 6a)", () => {
  async function amendTitle(root: string): Promise<void> {
    await handleTicketUpdate("T-001", { title: "Log in" }, "json", root);
    await reviewStore(root, { skipped: true });
    const result = await resolve1(root, "K2 (T-001)", "accept-current");
    expect(result.exitCode).toBe(0);
  }

  it.each(["step:freeze", "step:setup-note"])("after %s, the setup note and the one handover are at the new revision", async (point) => {
    const root = await stoppedAt(point);
    await amendTitle(root);
    const done = await progressPayload(root, "archived");
    expect(done.frozenHistory).toHaveLength(1);
    expect(done.frozen!.revision).toBe(effectiveRevision(done));
    for (const step of ["setup-note", "handover", "validate", "snapshot", "archive"]) {
      expect(done.receipts.filter((r) => r.step === step).at(-1)!.revision).toBe(done.frozen!.revision);
    }
    expect(done.receipts.at(-1)!.step).toBe("archive");
    const { state } = await loadProject(root);
    expect(state.notes.find((n) => (n as { setup?: { record?: string } }).setup?.record === "final")!.content).toContain('First story: T-001 "Log in"');
    expect(state.handoverFilenames).toHaveLength(1);
    expect(await readFile(join(root, setupHandoverPath(done)!), "utf-8")).toMatch(/^Setup record: SS-0123abcd handover\n/);
  });

  it.each(["step:handover", "step:validate", "step:snapshot", "archive-gated"])("after %s, a new handover names the one it supersedes, which stays as history", async (point) => {
    const root = await stoppedAt(point);
    const old = (await progressPayload(root, "active")).frozen!.handover.path;
    await amendTitle(root);
    const done = await progressPayload(root, "archived");
    const current = setupHandoverPath(done)!;
    expect(current).not.toBe(old);
    expect(current).toBe(done.frozen!.handover.path);
    const text = await readFile(join(root, current), "utf-8");
    expect(text.split("\n")[0]).toBe(`Setup record: ${SID} handover, revision ${done.frozen!.revision.slice(0, 12)}, supersedes ${old.split("/").at(-1)}`);
    expect(text).toContain('First story: T-001 "Log in"');
    expect(await readFile(join(root, old), "utf-8")).toContain('First story: T-001 "Sign in"');
    for (const step of ["setup-note", "handover", "validate", "snapshot", "archive"]) {
      expect(done.receipts.filter((r) => r.step === step).at(-1)!.revision).toBe(done.frozen!.revision);
    }
    expect(done.receipts.at(-1)!.step).toBe("archive");
  });

  it("an amendment whose contents freeze byte-equal re-stamps the receipts and writes no new handover", async () => {
    const root = await stoppedAt("step:snapshot");
    await writeFile(join(root, "CLAUDE.md"), "# mine now\n");
    const before = await progressPayload(root, "active");
    const result = await resolve1(root, "CLAUDE.md", "keep-current");
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContainEqual(expect.stringMatching(/^-> storybloq · finalization re-stamped to revision [0-9a-f]{12} \(contents unchanged\)$/));
    const done = await progressPayload(root, "archived");
    expect(done.frozen!.revision).not.toBe(before.frozen!.revision);
    expect(done.frozenHistory).toEqual([]);
    expect(done.receipts.filter((r) => r.revision !== undefined).every((r) => r.revision === done.frozen!.revision)).toBe(true);
    expect((await loadProject(root)).state.handoverFilenames).toHaveLength(1);
  });

  it("a setup note edited by hand before a material amendment is an ambiguity, and the user's bytes stay", async () => {
    const root = await stoppedAt("step:handover");
    const { state } = await loadProject(root);
    const note = state.notes.find((n) => (n as { setup?: { record?: string } }).setup?.record === "final")!;
    await editJson(join(root, ".story", "notes", `${note.id}.json`), (raw) => { raw.content = "my notes"; });
    await handleTicketUpdate("T-001", { title: "Log in" }, "json", root);
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContainEqual(expect.stringMatching(new RegExp(`^Ambiguity: setup note edited · ${note.id} · `)));
    expect((await loadProject(root)).state.notes.find((n) => n.id === note.id)!.content).toBe("my notes");
  });
});

describe("the handover lookup (plan v5 12.3)", () => {
  it("selects the handover whose receipt is at the current revision, not the one whose digest sorts first", () => {
    const p = validateSetupPayload(payload());
    const current = effectiveRevision(p);
    const older = "0".repeat(64);
    const withReceipts = {
      ...p,
      receipts: [
        { step: "handover", target: "file:.story/handovers/b-current.md", ownedPre: null, ownedPost: sha("b"), revision: current },
        { step: "handover", target: "file:.story/handovers/a-older.md", ownedPre: null, ownedPost: sha("a"), revision: older },
      ],
    };
    expect(setupHandoverPath(withReceipts)).toBe(".story/handovers/b-current.md");
    expect(setupHandoverPath({ ...p, receipts: [] })).toBeNull();
  });
});
