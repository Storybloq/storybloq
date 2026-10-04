import { describe, it, expect } from "vitest";
import { runDoctor, registerDoctorCheck, defaultChecks, checkStaleClaims, checkLocalIdAllocator, isClaimBranchGone, listRemoteBranchNames, parseRemoteBranches, type DoctorContext, type DoctorCheck } from "../../src/core/team-doctor.js";
import { makeTicket, makeIssue, makeState, makeRoadmap, makePhase, minimalConfig } from "./test-factories.js";
import type { Config } from "../../src/models/config.js";

const teamConfig: Config = { ...minimalConfig, schemaVersion: 2 };

function teamCtx(overrides?: Partial<DoctorContext>): DoctorContext {
  return {
    root: "/tmp/test-project",
    cliVersion: "1.0.0",
    isTeamMode: true,
    loadWarnings: [],
    ...overrides,
  };
}

function nonTeamCtx(): DoctorContext {
  return { root: "/tmp/test-project", cliVersion: "1.0.0", isTeamMode: false, loadWarnings: [] };
}

const state = (opts: Parameters<typeof makeState>[0]) =>
  makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]), config: teamConfig, ...opts });

describe("runDoctor", () => {
  it("returns no findings for a clean team-mode project", async () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
      ],
    });
    const result = await runDoctor(s, teamCtx());
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("returns info finding for non-team-mode project and skips team checks", async () => {
    const s = makeState({});
    const result = await runDoctor(s, nonTeamCtx());
    const teamFindings = result.findings.filter((f) => f.code !== "not_team_mode");
    expect(teamFindings).toHaveLength(0);
    const infoFinding = result.findings.find((f) => f.code === "not_team_mode");
    expect(infoFinding).toBeDefined();
    expect(infoFinding!.severity).toBe("info");
  });

  it("detects duplicate displayIds with reconcile repair", async () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
      ],
    });
    const result = await runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "duplicate_display_id");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.repair).not.toBeNull();
    if (finding!.repair && "command" in finding!.repair) {
      expect(finding!.repair.command).toContain("reconcile");
    }
  });

  it("warns on missing displayId in team mode", async () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", createdDate: "2026-01-01" }),
      ],
    });
    const result = await runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "missing_display_id");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns on unresolvable blockedBy ref", async () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", blockedBy: ["T-999"], createdDate: "2026-01-01" }),
      ],
    });
    const result = await runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "unresolvable_ref");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns when CLI version is below minCliVersion", async () => {
    const configWithMin: Config = { ...teamConfig, team: { minCliVersion: "99.0.0" } };
    const s = makeState({ config: configWithMin, roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = await runDoctor(s, teamCtx({ cliVersion: "1.0.0" }));
    const finding = result.findings.find((f) => f.code === "cli_version_mismatch");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns for a prerelease CLI below minCliVersion (ISS-692)", async () => {
    // The old private compareVersionStrings split only on "." and mapped through
    // Number(), so "2.0.0-rc.1".split(".")[2] = Number("0-rc") = NaN and `NaN < 0`
    // is false: the warning never fired for a prerelease, silently disabling the
    // check. The canonical comparator (splits on [.-], coerces non-finite to 0)
    // correctly orders "2.0.0-rc.1" below "2.0.1".
    const configWithMin: Config = { ...teamConfig, team: { minCliVersion: "2.0.1" } };
    const s = makeState({ config: configWithMin, roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = await runDoctor(s, teamCtx({ cliVersion: "2.0.0-rc.1" }));
    const finding = result.findings.find((f) => f.code === "cli_version_mismatch");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("does not warn for a release CLI at or above minCliVersion (ISS-692)", async () => {
    const configWithMin: Config = { ...teamConfig, team: { minCliVersion: "2.0.0" } };
    const s = makeState({ config: configWithMin, roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = await runDoctor(s, teamCtx({ cliVersion: "2.1.0" }));
    expect(result.findings.find((f) => f.code === "cli_version_mismatch")).toBeUndefined();
  });

  it("accepts injected custom checks via registerDoctorCheck", async () => {
    const customCheck: DoctorCheck = () => [
      { severity: "info", code: "custom_check", message: "Custom check ran", entity: null, repair: null },
    ];
    const originalLength = defaultChecks.length;
    registerDoctorCheck(customCheck);
    try {
      const s = state({ tickets: [] });
      const result = await runDoctor(s, teamCtx());
      const finding = result.findings.find((f) => f.code === "custom_check");
      expect(finding).toBeDefined();
    } finally {
      defaultChecks.length = originalLength;
    }
  });

  it("correctly counts findings by severity", async () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", blockedBy: ["T-999"], createdDate: "2026-01-01" }),
      ],
    });
    const result = await runDoctor(s, teamCtx());
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.errorCount + result.warningCount + result.infoCount).toBe(result.findings.length);
  });
});

describe("checkStaleClaims (ISS-698)", () => {
  // A huge threshold keeps age out of the picture so the branch-existence
  // condition is what these tests exercise. `since` stays a valid past ISO so
  // isClaimStale is deterministically false under that threshold.
  const longClaimConfig: Config = { ...teamConfig, team: { claimStalenessHours: 1_000_000 } };
  const longClaimState = (tickets: Parameters<typeof makeTicket>[0][]) =>
    state({ config: longClaimConfig, tickets: tickets.map((t) => makeTicket(t)) });

  const claimOn = (branch: string, extra?: Parameters<typeof makeTicket>[0]) => ({
    id: "t-aaa0000000000001",
    displayId: "T-001",
    status: "inprogress" as const,
    createdDate: "2026-01-01",
    claim: { user: "alice", branch, since: "2026-01-01T00:00:00Z" },
    ...extra,
  });

  it("flags a claim whose branch is absent from the remote set (spec condition 3)", () => {
    const s = longClaimState([claimOn("feat/gone")]);
    const findings = checkStaleClaims(s, teamCtx(), () => new Set(["main", "origin/main"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("stale_claim");
    expect(findings[0]!.message).toContain("no longer exists");
    expect(findings[0]!.message).toContain("feat/gone");
  });

  it("does not flag a claim whose branch is present (prefixed or stripped form)", () => {
    const s = longClaimState([claimOn("feat/live")]);
    const present = () => new Set(["origin/feat/live", "feat/live"]);
    expect(checkStaleClaims(s, teamCtx(), present)).toHaveLength(0);
  });

  it("skips the branch-gone check when the remote set is empty (git unavailable / no remotes)", () => {
    const s = longClaimState([claimOn("feat/gone")]);
    expect(checkStaleClaims(s, teamCtx(), () => new Set())).toHaveLength(0);
  });

  it("skips tombstoned tickets entirely, even with a missing branch", () => {
    const s = longClaimState([claimOn("feat/gone", { lifecycle: "deleted" })]);
    expect(checkStaleClaims(s, teamCtx(), () => new Set(["main"]))).toHaveLength(0);
  });

  it("still flags claim_on_complete regardless of branch existence", () => {
    const s = longClaimState([claimOn("feat/live", { status: "complete" })]);
    const findings = checkStaleClaims(s, teamCtx(), () => new Set(["feat/live"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("claim_on_complete");
  });

  it("still flags an age-stale claim under the default threshold", () => {
    // Default 48h threshold via teamConfig; an old `since` is age-stale even
    // though its branch is present, and age takes precedence over branch-gone.
    const s = state({
      tickets: [
        makeTicket({
          id: "t-aaa0000000000001",
          displayId: "T-001",
          status: "inprogress",
          createdDate: "2020-01-01",
          claim: { user: "alice", branch: "feat/live", since: "2020-01-01T00:00:00Z" },
        }),
      ],
    });
    const findings = checkStaleClaims(s, teamCtx(), () => new Set(["feat/live"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("stale_claim");
    expect(findings[0]!.message).toContain("since");
  });
});

describe("isClaimBranchGone (ISS-698)", () => {
  const remotes = new Set(["origin/main", "main", "origin/feat/x", "feat/x"]);
  it("returns false when the branch is present", () => {
    expect(isClaimBranchGone("feat/x", remotes)).toBe(false);
  });
  it("returns false when the prefixed branch form is present", () => {
    expect(isClaimBranchGone("origin/feat/x", remotes)).toBe(false);
  });
  it("returns true when the branch is absent", () => {
    expect(isClaimBranchGone("feat/gone", remotes)).toBe(true);
  });
  it("returns false for an empty or whitespace branch (cannot judge)", () => {
    expect(isClaimBranchGone("", remotes)).toBe(false);
    expect(isClaimBranchGone("   ", remotes)).toBe(false);
    expect(isClaimBranchGone(undefined, remotes)).toBe(false);
  });
});

describe("parseRemoteBranches (ISS-698)", () => {
  it("keeps full names and strips the origin prefix, skipping symbolic HEAD", () => {
    const set = parseRemoteBranches("  origin/HEAD -> origin/main\n  origin/main\n  origin/feat/x\n");
    expect(set.has("origin/main")).toBe(true);
    expect(set.has("origin/feat/x")).toBe(true);
    expect(set.has("main")).toBe(true);
    expect(set.has("feat/x")).toBe(true);
    expect(set.has("HEAD")).toBe(false);
  });

  it("strips only the sole non-origin remote", () => {
    const set = parseRemoteBranches("  upstream/feat/x\n");
    expect(set.has("upstream/feat/x")).toBe(true);
    expect(set.has("feat/x")).toBe(true);
  });

  it("with multiple remotes including origin, a bare claim matches the origin branch", () => {
    // origin is the default push target, so a local `feat/x` claim resolves to
    // origin/feat/x. The branch exists on a remote, so it must read as present.
    const set = parseRemoteBranches("  origin/feat/x\n  upstream/feat/x\n");
    expect(isClaimBranchGone("feat/x", set)).toBe(false);
    expect(isClaimBranchGone("upstream/feat/x", set)).toBe(false);
  });

  it("with multiple remotes and no origin, a bare claim is ambiguous and only full names match", () => {
    // Two non-origin remotes: stripping would be ambiguous, so a bare `feat/x`
    // does not match; only the exact `<remote>/feat/x` form does.
    const set = parseRemoteBranches("  alpha/feat/x\n  beta/feat/y\n");
    expect(isClaimBranchGone("feat/x", set)).toBe(true);
    expect(isClaimBranchGone("alpha/feat/x", set)).toBe(false);
    expect(isClaimBranchGone("beta/feat/y", set)).toBe(false);
  });

  it("returns an empty set for empty output", () => {
    expect(parseRemoteBranches("")).toEqual(new Set());
  });
});

describe("listRemoteBranchNames (ISS-698)", () => {
  it("returns an empty set for a non-git directory (graceful skip)", () => {
    expect(listRemoteBranchNames("/nonexistent-path-storybloq-xyz")).toEqual(new Set());
  });
});

describe("checkLocalIdAllocator (ISS-734)", () => {
  it("emits an info finding when a team-mode project uses the local allocator", async () => {
    const s = state({
      config: { ...teamConfig, team: { enabled: true, idAllocator: "local" } },
      tickets: [makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" })],
    });
    const result = await runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "local_id_allocator");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
    expect(finding!.message).toContain("reconcile");
    // ISS-1190: the exact same one-line remedy the create-time warning and
    // reconcile's collision output print.
    expect(finding!.message).toContain(
      "storybloq team init && storybloq team config set idAllocator git-refs",
    );
    // Nothing is broken: info must not affect error/warning counts.
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("treats an absent idAllocator as local (the runtime default)", () => {
    const s = state({ config: { ...teamConfig, team: { enabled: true } } });
    const findings = checkLocalIdAllocator(s, teamCtx());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("local_id_allocator");
  });

  it("emits nothing for a git-refs team", () => {
    const s = state({ config: { ...teamConfig, team: { enabled: true, idAllocator: "git-refs" } } });
    expect(checkLocalIdAllocator(s, teamCtx())).toHaveLength(0);
  });

  it("does not fire on non-team projects (runDoctor early-returns)", async () => {
    const s = makeState({});
    const result = await runDoctor(s, nonTeamCtx());
    expect(result.findings.find((f) => f.code === "local_id_allocator")).toBeUndefined();
  });
});

describe("T-522 commit 3: team doctor advises on the 1.16 rulings gaps", () => {
  it("warns when the fence is below 1.16.0 and when .gitattributes lacks the rulings line, each with the team setup repair", async () => {
    const { checkRulingLifecycleReadiness } = await import("../../src/core/team-doctor.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "doctor-rulings-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".story", "rulings"), { recursive: true });
    writeFileSync(join(root, ".story", ".gitattributes"), "# storybloq-merge-begin\ntickets/*.json merge=storybloq-json\n# storybloq-merge-end\n");
    // Without a single ruling on disk the check is silent: a project that records no rulings owes nothing.
    const silent = state({ config: { ...teamConfig, team: { enabled: true, minCliVersion: "1.4.4" } } as Config });
    expect(await checkRulingLifecycleReadiness(silent, teamCtx({ root, cliVersion: "1.16.0" }))).toEqual([]);
    writeFileSync(join(root, ".story", "rulings", "r-0000000000000001.json"), "{}");
    const low = state({ config: { ...teamConfig, team: { enabled: true, minCliVersion: "1.4.4" } } as Config });
    const findings = await checkRulingLifecycleReadiness(low, teamCtx({ root, cliVersion: "1.16.0" }));
    const codes = findings.map((f) => f.code).sort();
    expect(codes).toEqual(["gitattributes_no_rulings", "ruling_fence_below_1_16"]);
    for (const f of findings) {
      expect(f.severity).toBe("warning");
      expect(f.repair).toEqual({ command: ["storybloq", "team", "setup"] });
    }
    writeFileSync(join(root, ".story", ".gitattributes"), "# storybloq-merge-begin\nrulings/*.json merge=storybloq-json\n# storybloq-merge-end\n");
    const ok = state({ config: { ...teamConfig, team: { enabled: true, minCliVersion: "1.16.0" } } as Config });
    // T-486 A2: the attribute counts only beside the registration setup also writes.
    expect((await checkRulingLifecycleReadiness(ok, teamCtx({ root, cliVersion: "1.16.0" }))).map((f) => f.code)).toEqual(["ruling_merge_driver_registration"]);
    const { installMergeDriver } = await import("../../src/core/team-setup.js");
    await installMergeDriver(root);
    expect(await checkRulingLifecycleReadiness(ok, teamCtx({ root, cliVersion: "1.16.0" }))).toEqual([]);
  });

  it("is part of the default checks", async () => {
    const { defaultChecks, checkRulingLifecycleReadiness } = await import("../../src/core/team-doctor.js");
    expect(defaultChecks).toContain(checkRulingLifecycleReadiness);
  });
});

describe("T-529: team doctor warns when the catalogs would merge as text", () => {
  async function repoWithBlock(block: string): Promise<string> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "doctor-catalogs-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", ".gitattributes"), block);
    return root;
  }
  const OLD = "# storybloq-merge-begin\ntickets/*.json merge=storybloq-json\n# storybloq-merge-end\n";
  const NEW = "# storybloq-merge-begin\ncapabilities.json merge=storybloq-json\nglossary.json merge=storybloq-json\n# storybloq-merge-end\n";
  const teamWithDriver = { ...teamConfig, team: { enabled: true, minCliVersion: "1.4.4", mergeDriverVersion: 1 } } as Config;

  it("a team project with the driver installed and a pre-T-529 block gets one warning naming both files, repaired by team setup", async () => {
    const doctor = await import("../../src/core/team-doctor.js");
    const root = await repoWithBlock(OLD);
    const findings = doctor.checkCatalogMergeAttributes(state({ config: teamWithDriver }), teamCtx({ root }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", code: "gitattributes_no_catalogs", repair: { command: ["storybloq", "team", "setup"] } });
    expect(findings[0]!.message).toContain("capabilities.json and glossary.json");
  });

  it("silent once both lines are present", async () => {
    const doctor = await import("../../src/core/team-doctor.js");
    const root = await repoWithBlock(NEW);
    expect(doctor.checkCatalogMergeAttributes(state({ config: teamWithDriver }), teamCtx({ root }))).toEqual([]);
  });

  it("a team project that never ran team setup is sent to it too: the merge-driver check is silent there", async () => {
    const doctor = await import("../../src/core/team-doctor.js");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "doctor-catalogs-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const noDriver = { ...teamConfig, team: { enabled: true, minCliVersion: "1.4.4" } } as Config;
    const result = await runDoctor(state({ config: noDriver }), teamCtx({ root }));
    expect(result.findings.filter((f) => f.code === "gitattributes_no_catalogs")).toMatchObject([
      { severity: "warning", repair: { command: ["storybloq", "team", "setup"] } },
    ]);
    expect(result.findings.some((f) => f.code === "merge_driver_missing")).toBe(false);
  });

  it("silent for a project that is not team-enabled, and outside a git work tree", async () => {
    const doctor = await import("../../src/core/team-doctor.js");
    const root = await repoWithBlock(OLD);
    expect(doctor.checkCatalogMergeAttributes(state({ config: minimalConfig }), teamCtx({ root }))).toEqual([]);
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const notGit = mkdtempSync(join(tmpdir(), "doctor-catalogs-nogit-"));
    expect(doctor.checkCatalogMergeAttributes(state({ config: teamWithDriver }), teamCtx({ root: notGit }))).toEqual([]);
    expect(doctor.checkCatalogMergeAttributes(state({ config: teamWithDriver }), teamCtx({ root: join(notGit, "missing") }))).toEqual([]);
  });

  it("is part of the default checks", async () => {
    const doctor = await import("../../src/core/team-doctor.js");
    expect(doctor.defaultChecks).toContain(doctor.checkCatalogMergeAttributes);
  });
});
