/**
 * T-538 S3a-1: already-built work is a complete ticket in the payload
 * (pen ruling 3), checked on the effective dependency graph, created
 * complete on the setup's day, owned by the digest only when the payload
 * states a status, and restored with its date.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../../src/core/project-loader.js";
import { setupApply, setupApplySeams, setupResolve, setupResume } from "../../src/core/setup-apply.js";
import { effectiveEdges, parseSetupPayload, prerequisites, renderSetupPayload, validateSetupPayload } from "../../src/core/setup-payload.js";
import { parseSetupMeta } from "../../src/core/setup-meta.js";
import { setupPaths } from "../../src/core/setup-review.js";

vi.setConfig({ testTimeout: 30_000 });

const SID = "SS-0123abcd";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-s3a1c-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "TZ"]) saved[k] = process.env[k];
  // Setup writes local dates; the zone is pinned so the bytes do not depend on the host (the clock inputs are UTC instants too).
  process.env.TZ = "UTC";
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
  vi.useRealTimers();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "t538-s3a1c-"));
  dirs.push(d);
  return d;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const env = () => ({ ...process.env, STORYBLOQ_SETUP_REVIEW_DIR: join(scratchHome, "review-store") });

/** A completed review of `packet` for this setup, as the S2 resume tests record one; returns its revision. */
async function reviewStore(root: string, packet: string): Promise<string> {
  const paths = setupPaths(env(), root, SID);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.setupFile, JSON.stringify({ setupId: SID, projectKey: paths.projectKey, createdAt: "2026-10-18T00:00:00Z", cycle: 2, cycleReasons: {}, probe: null, probedAt: "2026-10-18T00:00:00Z" }));
  const revision = sha(packet);
  const dir = join(paths.records, "SR-0000000a");
  await mkdir(dir, { recursive: true });
  const output = JSON.stringify({ verdict: "approve", findings: [] });
  await writeFile(join(dir, "packet.md"), packet);
  await writeFile(join(dir, "reviewer-output.json"), output);
  const sections = Object.fromEntries(["Source requirements", "Owner answers and decisions", "Existing-state evidence", "Plan"].map((x) => [x, sha(x)]));
  await writeFile(join(dir, "record.json"), JSON.stringify({
    state: "completed", recordId: "SR-0000000a", setupId: SID, cycle: 2, round: 1, revisionSha256: revision, sectionSha256s: sections,
    backend: "codex", backendVersion: "1", startedAt: "2026-10-18T00:00:00Z", endedAt: "2026-10-18T00:01:00Z", exitCode: 0,
    outputSha256: sha(output), verdict: "approve", findingsCount: 0, reviewerSessionId: null, newCycleReason: "amendment",
  }));
  return revision;
}

/** Sets the date; a second call moves it (useFakeTimers alone keeps the first time once installed). */
const clock = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

type Ticket = { key: string; title: string; type: string; phase: string; description: string; blockedBy: string[]; status?: string };

/** K2 "Export" is already built; K3 "Sign in" is open; K7 has an explicit open. */
function payload(over: { tickets?: Ticket[]; checkpoints?: unknown[] } = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: { level: "minimal", verifyApplies: false, components: [{ id: "root", workdir: ".", test: null, build: null, verify: null }] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [] },
    git: { init: false, gitignore: [] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "" }],
    tickets: over.tickets ?? [
      { key: "K2", title: "Export", type: "feature", phase: "K1", description: "d", blockedBy: [], status: "complete" },
      { key: "K3", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: ["K2"] },
      { key: "K7", title: "Share", type: "feature", phase: "K1", description: "d", blockedBy: [], status: "open" },
    ],
    checkpoints: over.checkpoints ?? [],
    issues: [],
    coverage: [{ requirement: "R1", text: "export", source: "brief", keys: ["K2"] }],
  };
}

const t = (key: string, blockedBy: string[], status?: string): Ticket => ({ key, title: key, type: "task", phase: "K1", description: "", blockedBy, ...(status && { status }) });
const cp = (key: string, blockedBy: string[], gates: string[]) => ({ key, title: key, kind: "acceptance", criteria: "c", evidenceRefs: [], description: "", phase: "K1", blockedBy, gates });

async function ticketFile(root: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".story", "tickets", `${id}.json`), "utf-8")) as Record<string, unknown>;
}

async function editTicket(root: string, id: string, edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const path = join(root, ".story", "tickets", `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
}

function faultOnce(point: string): void {
  let fired = false;
  setupApplySeams.fault = (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Error(`injected fault at ${p}`);
    }
  };
}

describe("the payload", () => {
  it("keeps an absent status absent through parse and render", () => {
    const legacy = payload({ tickets: [t("K2", [])] });
    const parsed = validateSetupPayload(legacy);
    expect("status" in parsed.tickets[0]!).toBe(false);
    const rendered = renderSetupPayload(parsed);
    expect(rendered).not.toContain('"status"');
    expect(parseSetupPayload(rendered)).toEqual(parsed);
  });

  it("accepts complete work that depends only on complete work", () => {
    expect(() => validateSetupPayload(payload({ tickets: [t("K2", [], "complete"), t("K3", ["K2"], "complete"), t("K4", ["K3"])] }))).not.toThrow();
  });

  it.each([
    ["an open blocker", [t("K2", []), t("K3", ["K2"], "complete")], [], "K3 is complete but depends on K2, which is not"],
    ["an open blocker two steps away", [t("K2", []), t("K3", ["K2"], "complete"), t("K4", ["K3"], "complete")], [], "K3 is complete but depends on K2, which is not"],
    ["a checkpoint blocker", [t("K2", []), t("K3", ["K5"], "complete")], [cp("K5", ["K2"], [])], "K3 is complete but depends on K5, which is not"],
    ["a checkpoint gate", [t("K2", []), t("K3", [], "complete")], [cp("K5", ["K2"], ["K3"])], "K5 gates K3, which is already complete"],
    ["an explicit open blocker", [t("K2", [], "open"), t("K3", ["K2"], "complete")], [], "K3 is complete but depends on K2, which is not"],
  ])("refuses a complete ticket with %s", (_name, tickets, checkpoints, message) => {
    expect(() => validateSetupPayload(payload({ tickets, checkpoints }))).toThrow(message);
  });

  it("the effective graph includes checkpoint gates", () => {
    const p = validateSetupPayload(payload({ tickets: [t("K2", []), t("K3", [])], checkpoints: [cp("K5", ["K2"], ["K3"])] }));
    expect(effectiveEdges(p).get("K3")).toEqual(["K5"]);
    expect([...prerequisites(p, "K3")].sort()).toEqual(["K2", "K5"]);
  });
});

describe("applying already-built work", () => {
  it("creates the ticket complete, dated the setup's first day, and reports it as built", async () => {
    const root = await folder();
    clock("2026-10-20T12:00:00Z");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(0);
    const built = await ticketFile(root, "T-001");
    expect(built.title).toBe("Export");
    expect(built.status).toBe("complete");
    expect(built.completedDate).toBe("2026-10-20");
    expect((await ticketFile(root, "T-002")).status).toBe("open");
    expect(result.lines).toContain("Created: 1 phases, 3 tickets (1 already built), 0 checkpoints, 0 issues");
    expect(result.lines).toContain('First story: T-002 "Sign in"');
    expect(result.lines.find((l) => l.startsWith("Ready to build:"))).not.toContain("Export");
  });

  it("dates the ticket the setup's first day when it is created on a later day", async () => {
    const root = await folder();
    clock("2026-10-20T12:00:00Z");
    // The fault fires after the phase step, so the complete ticket is first written by the resume.
    faultOnce("step:phase:K1");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    setupApplySeams.fault = () => {};
    clock("2026-10-23T12:00:00Z");
    expect((await setupResume(root, SID)).exitCode).toBe(0);
    expect((await ticketFile(root, "T-001")).completedDate).toBe("2026-10-20");
  });
});

describe("the status as an owned field", () => {
  async function interrupted(): Promise<string> {
    const root = await folder();
    clock("2026-10-20T12:00:00Z");
    faultOnce("step:config");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    setupApplySeams.fault = () => {};
    return root;
  }

  it("an owner reopening already-built work is drift, named by status", async () => {
    const root = await interrupted();
    await editTicket(root, "T-001", (r) => { r.status = "open"; r.completedDate = null; });
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    expect(result.lines).toContain("Ambiguity: owned field edited · K2 (T-001) · observed status differ from the plan; expected the values setup wrote · resolutions: accept-current | restore-planned | stop");
  });

  it("an ordinary ticket moving to inprogress is not drift", async () => {
    const root = await interrupted();
    await editTicket(root, "T-002", (r) => { r.status = "inprogress"; });
    expect((await setupResume(root, SID)).exitCode).toBe(0);
  });

  it("restore-planned on a later day brings back complete with the first day's date, again and again", async () => {
    const root = await interrupted();
    for (const day of ["2026-10-21", "2026-10-22"]) {
      await editTicket(root, "T-001", (r) => { r.status = "open"; r.completedDate = null; });
      clock(`${day}T12:00:00Z`);
      expect((await setupResume(root, SID)).exitCode).toBe(4);
      // The resolution goes on to finish the setup; stop it again at config so the next day has a setup to resume.
      faultOnce("step:config");
      expect((await setupResolve(root, SID, [{ target: "K2 (T-001)", resolution: "restore-planned", ownerWords: "it is built" }])).exitCode).toBe(3);
      setupApplySeams.fault = () => {};
      const restored = await ticketFile(root, "T-001");
      expect([restored.status, restored.completedDate]).toEqual(["complete", "2026-10-20"]);
    }
    expect((await setupResume(root, SID)).exitCode).toBe(0);
    expect((await ticketFile(root, "T-001")).completedDate).toBe("2026-10-20");
  });

  it("restore-planned on an explicit open that the owner closed clears the date", async () => {
    const root = await interrupted();
    await editTicket(root, "T-003", (r) => { r.status = "complete"; r.completedDate = "2026-10-21"; });
    expect((await setupResume(root, SID)).exitCode).toBe(4);
    expect((await setupResolve(root, SID, [{ target: "K7 (T-003)", resolution: "restore-planned", ownerWords: "not done" }])).exitCode).toBe(0);
    const restored = await ticketFile(root, "T-003");
    expect([restored.status, restored.completedDate]).toEqual(["open", null]);
    expect((await setupResume(root, SID)).exitCode).toBe(0);
  });

  it("accept-current keeps the owner's status and resumes clean", async () => {
    const root = await interrupted();
    await editTicket(root, "T-001", (r) => { r.status = "open"; r.completedDate = null; });
    expect((await setupResume(root, SID)).exitCode).toBe(4);
    const reviewRevision = await reviewStore(root, "# amended packet\n");
    const resolved = await setupResolve(root, SID, [{ target: "K2 (T-001)", resolution: "accept-current", ownerWords: "not built after all", reviewRevision }], { env: env() });
    expect(resolved.exitCode).toBe(0);
    expect(resolved.lines.at(-1)).toBe(`Setup applied: ${SID}`);
    expect((await ticketFile(root, "T-001")).status).toBe("open");
  });

  it("an owner date change alone on already-built work is drift", async () => {
    const root = await interrupted();
    await editTicket(root, "T-001", (r) => { r.completedDate = "2026-10-01"; });
    const result = await setupResume(root, SID);
    expect(result.exitCode).toBe(4);
    const { state } = await loadProject(root);
    expect(parseSetupMeta("ticket", state.ticketByID("T-001")!).kind).toBe("item");
  });
});

describe("restore-planned meets the ordinary lifecycle authorisation (review S3a-1 #1)", () => {
  /** Every ledger file's bytes, so a refusal can be shown to write nothing. */
  async function ledger(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const dir of ["tickets", "notes", "issues"]) {
      const at = join(root, ".story", dir);
      for (const f of (await readdir(at).catch(() => [] as string[])).sort()) out[`${dir}/${f}`] = await readFile(join(at, f), "utf-8");
    }
    out["config.json"] = await readFile(join(root, ".story", "config.json"), "utf-8");
    return out;
  }

  async function interrupted(over: Parameters<typeof payload>[0] = {}): Promise<string> {
    const root = await folder();
    clock("2026-10-20T12:00:00Z");
    faultOnce("step:config");
    expect((await setupApply(root, payload(over))).exitCode).toBe(3);
    setupApplySeams.fault = () => {};
    return root;
  }

  async function refusedWithoutWrite(root: string, reason: RegExp): Promise<void> {
    expect((await setupResume(root, SID)).exitCode).toBe(4);
    const before = await ledger(root);
    const result = await setupResolve(root, SID, [{ target: "K2 (T-001)", resolution: "restore-planned", ownerWords: "it is built" }]);
    expect(result.exitCode).toBe(2);
    expect(result.lines.at(-1)).toMatch(reason);
    expect(await ledger(root)).toEqual(before);
  }

  it("refuses to complete work another user has claimed", async () => {
    const root = await interrupted();
    await editTicket(root, "T-001", (r) => { r.status = "inprogress"; r.completedDate = null; r.claim = { user: "rival@example.com", branch: "rival", since: "2026-10-21" }; });
    await refusedWithoutWrite(root, /^Setup refused: K2 \(T-001\): restore-planned refused: Cannot complete T-001: it is claimed by rival@example\.com and this caller cannot prove ownership/);
  });

  it("refuses to complete work a session has claimed", async () => {
    const root = await interrupted();
    await editTicket(root, "T-001", (r) => { r.status = "inprogress"; r.completedDate = null; r.claimedBySession = "11111111-2222-3333-4444-555555555555"; });
    await refusedWithoutWrite(root, /^Setup refused: K2 \(T-001\): restore-planned refused: Cannot complete T-001: it is claimed by another session/);
  });

  it("refuses to complete work that now waits on an owner checkpoint not yet answered", async () => {
    const root = await interrupted({ checkpoints: [cp("K4", ["K7"], [])] });
    const { state } = await loadProject(root);
    const checkpoint = state.tickets.find((x) => (x as { setup?: { key?: string } }).setup?.key === "K4")!;
    await editTicket(root, "T-001", (r) => { r.status = "open"; r.completedDate = null; r.blockedBy = [checkpoint.id]; });
    await refusedWithoutWrite(root, new RegExp(`^Setup refused: K2 \\(T-001\\): restore-planned refused: Cannot complete T-001: it waits on owner checkpoint ${checkpoint.id}, not yet approved or retired`));
  });

  it("completes work the caller's own claim holds, and the claim goes with the completion", async () => {
    await writeFile(join(scratchHome, "gitconfig"), "[user]\n\temail = sam@example.com\n");
    try {
      const root = await interrupted();
      await editTicket(root, "T-001", (r) => { r.status = "inprogress"; r.completedDate = null; r.claim = { user: "sam@example.com", branch: "main", since: "2026-10-21" }; });
      expect((await setupResume(root, SID)).exitCode).toBe(4);
      expect((await setupResolve(root, SID, [{ target: "K2 (T-001)", resolution: "restore-planned", ownerWords: "it is built" }])).exitCode).toBe(0);
      const restored = await ticketFile(root, "T-001");
      expect([restored.status, restored.completedDate, "claim" in restored]).toEqual(["complete", "2026-10-20", false]);
    } finally {
      await rm(join(scratchHome, "gitconfig"), { force: true });
    }
  });
});
