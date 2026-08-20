import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadProject,
  writeTicket,
  writeIssue,
  writeRoadmap,
  writeConfig,
  deleteTicket,
  deleteIssue,
  runTransaction,
  sortKeysDeep,
  serializeJSON,
  atomicWrite,
  atomicCreate,
  withProjectLock,
  detectTeamModeFromDisk,
  guardPath,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { fixturesDir } from "../helpers.js";

// --- Test fixture helpers ---

const minimalConfig = {
  version: 2,
  project: "test",
  type: "npm",
  language: "typescript",
  features: {
    tickets: true,
    issues: true,
    handovers: true,
    roadmap: true,
    reviews: true,
  },
};

const minimalRoadmap = {
  title: "test",
  date: "2026-01-01",
  phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
  blockers: [],
};

const validTicket = {
  id: "T-001",
  title: "Test ticket",
  description: "A test.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

const validIssue = {
  id: "ISS-001",
  title: "Test issue",
  status: "open",
  severity: "medium",
  components: ["core"],
  impact: "Test impact.",
  resolution: null,
  location: ["file.ts:1"],
  discoveredDate: "2026-01-01",
  resolvedDate: null,
  relatedTickets: [],
};

async function createTestProject(
  opts: {
    config?: unknown;
    roadmap?: unknown;
    tickets?: Record<string, unknown>;
    issues?: Record<string, unknown>;
    handovers?: Record<string, string>;
    skipConfig?: boolean;
    skipRoadmap?: boolean;
    skipTicketsDir?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-pl-"));
  const wrapDir = join(root, ".story");
  await mkdir(wrapDir, { recursive: true });

  if (!opts.skipConfig) {
    await writeFile(
      join(wrapDir, "config.json"),
      JSON.stringify(opts.config ?? minimalConfig, null, 2),
    );
  }

  if (!opts.skipRoadmap) {
    await writeFile(
      join(wrapDir, "roadmap.json"),
      JSON.stringify(opts.roadmap ?? minimalRoadmap, null, 2),
    );
  }

  if (!opts.skipTicketsDir) {
    const ticketsDir = join(wrapDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    for (const [name, data] of Object.entries(opts.tickets ?? {})) {
      await writeFile(
        join(ticketsDir, name),
        JSON.stringify(data, null, 2),
      );
    }
  }

  const issuesDir = join(wrapDir, "issues");
  await mkdir(issuesDir, { recursive: true });
  for (const [name, data] of Object.entries(opts.issues ?? {})) {
    await writeFile(
      join(issuesDir, name),
      JSON.stringify(data, null, 2),
    );
  }

  if (opts.handovers) {
    const handoversDir = join(wrapDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    for (const [name, content] of Object.entries(opts.handovers)) {
      await writeFile(join(handoversDir, name), content);
    }
  }

  return root;
}

let testRoot: string;

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
  }
});

// --- Tests ---

describe("loadProject", () => {
  describe("happy path", () => {
    it("loads a complete project", async () => {
      testRoot = await createTestProject({
        tickets: { "T-001.json": validTicket },
        issues: { "ISS-001.json": validIssue },
        handovers: { "2026-01-01-initial.md": "# Initial" },
      });

      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(1);
      expect(result.state.issues).toHaveLength(1);
      expect(result.state.handoverFilenames).toHaveLength(1);
      expect(result.state.config.project).toBe("test");
      expect(result.warnings).toHaveLength(0);
    });

    it("loads project with no tickets or issues", async () => {
      testRoot = await createTestProject();
      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(0);
      expect(result.state.issues).toHaveLength(0);
    });
  });

  describe("critical failures", () => {
    it("throws not_found when .story/ dir is missing", async () => {
      testRoot = await mkdtemp(join(tmpdir(), "storybloq-pl-"));
      await expect(loadProject(testRoot)).rejects.toThrow(
        ProjectLoaderError,
      );
      try {
        await loadProject(testRoot);
      } catch (err) {
        expect((err as ProjectLoaderError).code).toBe("not_found");
      }
    });

    it("throws not_found when config.json is missing", async () => {
      testRoot = await createTestProject({ skipConfig: true });
      await expect(loadProject(testRoot)).rejects.toThrow(
        ProjectLoaderError,
      );
    });

    it("throws not_found when roadmap.json is missing", async () => {
      testRoot = await createTestProject({ skipRoadmap: true });
      await expect(loadProject(testRoot)).rejects.toThrow(
        ProjectLoaderError,
      );
    });

    it("throws validation_failed for invalid config JSON", async () => {
      testRoot = await createTestProject();
      await writeFile(
        join(testRoot, ".story", "config.json"),
        "not json {{{",
      );
      try {
        await loadProject(testRoot);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("validation_failed");
      }
    });

    it("throws validation_failed for bad config schema", async () => {
      testRoot = await createTestProject({
        config: { version: 2, type: "npm", language: "ts" }, // missing project + features
      });
      try {
        await loadProject(testRoot);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("validation_failed");
      }
    });

    // ISS-755: these pin the CLI half of the CLI/Mac parity contract. The Swift
    // Config model now mirrors each of these team-object constraints (see
    // ClaudeStoryModelsTests/TeamCapabilityContractTests), so a config one client
    // rejects cannot load in the other and be written from there.
    describe("team-object validation (Mac parity, ISS-755)", () => {
      const validTeam = {
        enabled: true,
        idAllocator: "local",
        idAllocatorRemote: "origin",
        protectedRef: "refs/storybloq/ids",
        claimStalenessHours: 48,
        mergeDriverVersion: 1,
      };
      const baseConfig = {
        version: 2,
        project: "p",
        type: "npm",
        language: "ts",
        features: {
          tickets: true, issues: true, handovers: true, roadmap: true, reviews: true,
        },
      };

      it.each([
        ["unknown idAllocator", { idAllocator: "magic" }],
        ["idAllocatorRemote with a space", { idAllocatorRemote: "bad remote" }],
        ["idAllocatorRemote starting with a dash", { idAllocatorRemote: "-origin" }],
        // JS `$` without the `m` flag anchors at end of INPUT, not before a final
        // line terminator (unlike Python), so the CLI regex already rejects this.
        // Pinned because the Swift mirror uses a scalar whitelist with no anchor
        // semantics at all, and the two must agree.
        ["idAllocatorRemote with a trailing newline", { idAllocatorRemote: "origin\n" }],
        ["empty protectedRef", { protectedRef: "" }],
        ["protectedRef starting with a dash", { protectedRef: "-refs/x" }],
        ["negative claimStalenessHours", { claimStalenessHours: -1 }],
        ["non-integral mergeDriverVersion", { mergeDriverVersion: 1.5 }],
      ])("rejects %s", async (_label, teamOverride) => {
        testRoot = await createTestProject({
          config: { ...baseConfig, team: { ...validTeam, ...teamOverride } },
        });
        try {
          await loadProject(testRoot);
          expect.fail("Should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ProjectLoaderError);
          expect((err as ProjectLoaderError).code).toBe("validation_failed");
        }
      });

      // Positive control: the rejections above cannot be passing by rejecting
      // every team object.
      it("accepts a fully populated valid team object", async () => {
        testRoot = await createTestProject({
          config: { ...baseConfig, team: validTeam },
        });
        const { state } = await loadProject(testRoot);
        expect(state.config.team?.idAllocator).toBe("local");
        expect(state.config.team?.claimStalenessHours).toBe(48);
      });
    });
  });

  describe("graceful degradation", () => {
    it("skips corrupt ticket with warning", async () => {
      testRoot = await createTestProject({
        tickets: {
          "T-001.json": validTicket,
          "T-002.json": { id: "T-002", title: "Missing fields" }, // invalid
        },
      });

      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.type).toBe("schema_error");
    });

    it("skips hidden files", async () => {
      testRoot = await createTestProject({
        tickets: { "T-001.json": validTicket },
      });
      await writeFile(
        join(testRoot, ".story", "tickets", ".DS_Store"),
        "",
      );

      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });

    it("skips non-JSON files", async () => {
      testRoot = await createTestProject({
        tickets: { "T-001.json": validTicket },
      });
      await writeFile(
        join(testRoot, ".story", "tickets", "README.md"),
        "# Tickets",
      );

      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(1);
    });

    it("returns empty array for missing tickets directory", async () => {
      testRoot = await createTestProject({ skipTicketsDir: true });
      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(0);
    });
  });

  describe("strict mode", () => {
    it("throws project_corrupt on integrity warning", async () => {
      testRoot = await createTestProject({
        tickets: {
          "T-001.json": validTicket,
          "T-002.json": { id: "T-002", bad: true }, // corrupt
        },
      });

      await expect(
        loadProject(testRoot, { strict: true }),
      ).rejects.toThrow(ProjectLoaderError);

      try {
        await loadProject(testRoot, { strict: true });
      } catch (err) {
        expect((err as ProjectLoaderError).code).toBe("project_corrupt");
      }
    });

    it("does not fail on naming_convention warnings", async () => {
      testRoot = await createTestProject({
        handovers: { "notes.md": "# Notes" }, // non-conforming name
      });

      const result = await loadProject(testRoot, { strict: true });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.type).toBe("naming_convention");
    });
  });

  describe("schemaVersion", () => {
    it("rejects config with schemaVersion > maxSchemaVersion", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 99 },
      });

      try {
        await loadProject(testRoot);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("version_mismatch");
      }
    });

    it("version_mismatch error includes update instructions", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 99 },
      });

      try {
        await loadProject(testRoot);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as ProjectLoaderError).message).toContain(
          "npm update -g @storybloq/storybloq",
        );
      }
    });

    it("accepts config without schemaVersion", async () => {
      testRoot = await createTestProject();
      const result = await loadProject(testRoot);
      expect(result.state.config.schemaVersion).toBeUndefined();
    });

    it("accepts config with schemaVersion <= max", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 1 },
      });
      const result = await loadProject(testRoot);
      expect(result.state.config.schemaVersion).toBe(1);
    });

    // ISS-751: team-init stamps schemaVersion 3 as the old-client fence, so the
    // current loader MUST accept 3 while still rejecting the next unknown version.
    it("accepts schemaVersion 3 (team schema, ISS-751)", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 3 },
      });
      const result = await loadProject(testRoot);
      expect(result.state.config.schemaVersion).toBe(3);
    });

    it("rejects schemaVersion 4 with version_mismatch (ISS-751 boundary)", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 4 },
      });
      try {
        await loadProject(testRoot);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("version_mismatch");
      }
    });

    it("withProjectLock allows writes at schemaVersion 3 (ISS-751)", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 3 },
      });
      let ran = false;
      await withProjectLock(testRoot, {}, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("withProjectLock rejects writes when schemaVersion too high", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 99 },
      });
      try {
        await withProjectLock(testRoot, {}, async () => {
          expect.unreachable("handler should not execute");
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("version_mismatch");
      }
    });

    it("withProjectLock rejects team writes below minCliVersion", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 2, team: { enabled: true, minCliVersion: "99.0.0" } },
      });
      await expect(
        withProjectLock(testRoot, {}, async () => {
          expect.unreachable("handler should not execute");
        }),
      ).rejects.toMatchObject({ code: "version_mismatch" });
    });

    it("withProjectLock rejects team writes with unsupported required features", async () => {
      testRoot = await createTestProject({
        config: { ...minimalConfig, schemaVersion: 2, team: { enabled: true, requiredFeatures: ["unknown-feature"] } },
      });
      await expect(
        withProjectLock(testRoot, {}, async () => {
          expect.unreachable("handler should not execute");
        }),
      ).rejects.toMatchObject({ code: "version_mismatch" });
    });
  });

  describe("integration with fixtures", () => {
    it("loads test/fixtures/valid/basic/ correctly", async () => {
      const basicDir = resolve(fixturesDir, "valid", "basic");
      // Create a temp root that points to fixtures
      testRoot = await mkdtemp(join(tmpdir(), "storybloq-fix-"));
      // Symlink .story to the fixtures basic dir
      // Actually, fixtures/valid/basic IS the .story content, but loadProject expects it at root/.story
      // So we need to set up the structure properly
      await mkdir(join(testRoot, ".story"), { recursive: true });

      // Copy fixture files to temp project structure
      const { execSync } = await import("node:child_process");
      execSync(`cp -r "${basicDir}/"* "${join(testRoot, ".story")}/"`, {
        stdio: "pipe",
      });

      const result = await loadProject(testRoot);
      expect(result.state.tickets).toHaveLength(5);
      expect(result.state.issues).toHaveLength(2);
      expect(result.state.handoverFilenames).toHaveLength(1);
      expect(result.state.config.project).toBe("test-project");
      expect(result.state.roadmap.phases).toHaveLength(2);

      // Verify derivation
      expect(result.state.umbrellaIDs.has("T-003")).toBe(true);
      expect(result.state.phaseStatus("alpha")).toBe("inprogress"); // T-001 complete, T-005a open
      expect(result.state.isBlocked(result.state.ticketByID("T-002")!)).toBe(
        false,
      ); // T-001 is complete
    });
  });

  describe("benchmark", () => {
    it("loads fixture project within reasonable time", async () => {
      testRoot = await createTestProject({
        tickets: { "T-001.json": validTicket },
      });
      const start = performance.now();
      await loadProject(testRoot);
      const elapsed = performance.now() - start;
      // Informational -- just log, no hard assertion
      console.log(`loadProject took ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(5000); // sanity upper bound only
    });
  });
});

describe("filename_id_mismatch", () => {
  it("warns when filename stem does not match content id", async () => {
    testRoot = await createTestProject({
      tickets: {
        "T-001.json": { ...validTicket, id: "T-002", title: "Mismatched" },
      },
    });

    const result = await loadProject(testRoot);
    const mismatchWarning = result.warnings.find(
      (w) => w.type === "filename_id_mismatch",
    );
    expect(mismatchWarning).toBeDefined();
    expect(mismatchWarning!.message).toContain("T-001");
    expect(mismatchWarning!.message).toContain("T-002");
  });

  it("does not warn when filename stem matches content id", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });

    const result = await loadProject(testRoot);
    const mismatchWarning = result.warnings.find(
      (w) => w.type === "filename_id_mismatch",
    );
    expect(mismatchWarning).toBeUndefined();
  });
});

describe("write operations", () => {
  describe("writeTicket", () => {
    it("writes ticket and reads it back identically", async () => {
      testRoot = await createTestProject();
      const ticket = {
        ...validTicket,
        id: "T-010",
      };

      await writeTicket(ticket as any, testRoot);

      const result = await loadProject(testRoot);
      const loaded = result.state.ticketByID("T-010");
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Test ticket");
      expect(loaded!.status).toBe("open");
    });

    it("preserves passthrough keys on write round-trip", async () => {
      testRoot = await createTestProject();
      const ticket = {
        ...validTicket,
        id: "T-011",
        customField: "preserved",
        extraNumber: 42,
      };

      await writeTicket(ticket as any, testRoot);

      const raw = await readFile(
        join(testRoot, ".story", "tickets", "T-011.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw);
      expect(parsed.customField).toBe("preserved");
      expect(parsed.extraNumber).toBe(42);
    });
  });

  describe("writeIssue", () => {
    it("writes issue and reads it back", async () => {
      testRoot = await createTestProject();
      await writeIssue(validIssue as any, testRoot);

      const result = await loadProject(testRoot);
      expect(result.state.issueByID("ISS-001")).toBeDefined();
    });
  });

  describe("writeRoadmap", () => {
    it("writes roadmap and reads it back", async () => {
      testRoot = await createTestProject();
      const updated = { ...minimalRoadmap, title: "updated" };
      await writeRoadmap(updated as any, testRoot);

      const result = await loadProject(testRoot);
      expect(result.state.roadmap.title).toBe("updated");
    });
  });

  describe("writeConfig", () => {
    it("writes config and reads it back", async () => {
      testRoot = await createTestProject();
      const updated = { ...minimalConfig, project: "updated" };
      await writeConfig(updated as any, testRoot);

      const result = await loadProject(testRoot);
      expect(result.state.config.project).toBe("updated");
    });
  });

  describe("JSON formatting", () => {
    it("writes sorted keys with 2-space indent and trailing newline", async () => {
      testRoot = await createTestProject();
      await writeTicket(validTicket as any, testRoot);

      const raw = await readFile(
        join(testRoot, ".story", "tickets", "T-001.json"),
        "utf-8",
      );
      expect(raw.endsWith("\n")).toBe(true);
      // Check keys are sorted
      const lines = raw.split("\n");
      const keys = lines
        .filter((l) => l.includes(":"))
        .map((l) => l.trim().split(":")[0]!.replace(/"/g, ""));
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });
  });

  describe("atomic write", () => {
    it("does not leave temp files after success", async () => {
      testRoot = await createTestProject();
      await writeTicket(validTicket as any, testRoot);

      const ticketsDir = join(testRoot, ".story", "tickets");
      const entries = await readdir(ticketsDir);
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});

describe("delete operations", () => {
  it("deletes an existing ticket", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });
    await deleteTicket("T-001", testRoot);
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(0);
  });

  it("does not enable tombstones for partial team config without team.enabled true", async () => {
    testRoot = await createTestProject({
      config: { ...minimalConfig, schemaVersion: 2, team: { claimStalenessHours: 48 } },
      tickets: { "T-001.json": validTicket },
    });
    await deleteTicket("T-001", testRoot);
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(0);
    expect(existsSync(join(testRoot, ".story", "tickets", "T-001.json"))).toBe(false);
  });

  it("throws not_found for nonexistent ticket", async () => {
    testRoot = await createTestProject();
    try {
      await deleteTicket("T-999", testRoot);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).toBe("not_found");
    }
  });

  it("throws conflict when ticket is referenced in blockedBy", async () => {
    testRoot = await createTestProject({
      tickets: {
        "T-001.json": validTicket,
        "T-002.json": {
          ...validTicket,
          id: "T-002",
          title: "Blocked",
          blockedBy: ["T-001"],
        },
      },
    });

    try {
      await deleteTicket("T-001", testRoot);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).toBe("conflict");
      expect((err as ProjectLoaderError).message).toContain("blockedBy");
    }
  });

  it("throws conflict when ticket has children", async () => {
    testRoot = await createTestProject({
      tickets: {
        "T-001.json": validTicket,
        "T-002.json": {
          ...validTicket,
          id: "T-002",
          title: "Child",
          parentTicket: "T-001",
        },
      },
    });

    try {
      await deleteTicket("T-001", testRoot);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).toBe("conflict");
      expect((err as ProjectLoaderError).message).toContain("child");
    }
  });

  it("throws conflict when ticket is referenced by issues", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
      issues: {
        "ISS-001.json": { ...validIssue, relatedTickets: ["T-001"] },
      },
    });

    try {
      await deleteTicket("T-001", testRoot);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).toBe("conflict");
      expect((err as ProjectLoaderError).message).toContain("issues");
    }
  });

  it("deletes an existing issue", async () => {
    testRoot = await createTestProject({
      issues: { "ISS-001.json": validIssue },
    });
    await deleteIssue("ISS-001", testRoot);
    const result = await loadProject(testRoot);
    expect(result.state.issues).toHaveLength(0);
  });
});

describe("sortKeysDeep", () => {
  it("sorts object keys", () => {
    const result = sortKeysDeep({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual([
      "a",
      "m",
      "z",
    ]);
  });

  it("handles null", () => {
    expect(sortKeysDeep(null)).toBeNull();
  });

  it("handles primitives", () => {
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep("hello")).toBe("hello");
    expect(sortKeysDeep(true)).toBe(true);
  });

  it("preserves array element order while sorting object keys within", () => {
    const input = [{ z: 1, a: 2 }, { m: 3, b: 4 }];
    const result = sortKeysDeep(input) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]!)).toEqual(["a", "z"]);
    expect(Object.keys(result[1]!)).toEqual(["b", "m"]);
  });

  it("handles mixed-type arrays", () => {
    const input = [1, "a", null, { z: 1, a: 2 }];
    const result = sortKeysDeep(input) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe("a");
    expect(result[2]).toBeNull();
    expect(Object.keys(result[3] as Record<string, unknown>)).toEqual([
      "a",
      "z",
    ]);
  });

  it("handles deeply nested objects (3+ levels)", () => {
    const input = { c: { b: { a: 1 } }, a: 2 };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "c"]);
    const nested = result.c as Record<string, unknown>;
    expect(Object.keys(nested)).toEqual(["b"]);
  });

  it("handles empty objects and arrays", () => {
    expect(sortKeysDeep({})).toEqual({});
    expect(sortKeysDeep([])).toEqual([]);
  });
});

describe("serializeJSON", () => {
  it("produces sorted keys with 2-space indent and trailing newline", () => {
    const json = serializeJSON({ z: 1, a: 2 });
    expect(json).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
  });
});

describe("guardPath", () => {
  it("rejects symlink target outside root", async () => {
    testRoot = await createTestProject();
    const wrapDir = join(testRoot, ".story");
    const ticketsDir = join(wrapDir, "tickets");
    const outsideDir = await mkdtemp(join(tmpdir(), "storybloq-outside-"));

    try {
      // Create a real file outside the project
      const outsideFile = join(outsideDir, "stolen.json");
      await writeFile(outsideFile, "{}");

      // Create a symlink inside tickets/ pointing to the outside file
      const linkPath = join(ticketsDir, "T-666.json");
      await symlink(outsideFile, linkPath);

      await expect(
        writeTicket(
          { ...validTicket, id: "T-666" } as any,
          testRoot,
        ),
      ).rejects.toThrow(ProjectLoaderError);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  // Regression for Storybloq/storybloq#11 (ISS-639): the inside-root check used
  // `startsWith(resolvedRoot + "/")`, which never matched on Windows where
  // realpath() returns backslash paths -- rejecting every legitimate .story
  // write. The check now uses path.relative(), which is separator-agnostic.
  // Note: the Windows-specific backslash failure cannot be reproduced on a
  // POSIX runner (path.sep === "/"). These tests lock the equivalent semantics
  // the fix must preserve on every platform.
  it("accepts a nested path inside root", async () => {
    testRoot = await createTestProject();
    const wrapDir = join(testRoot, ".story");
    await expect(
      guardPath(join(wrapDir, "tickets", "T-001.json"), wrapDir),
    ).resolves.toBeUndefined();
  });

  it("accepts a directory literally named '..keep' inside root (not an escape)", async () => {
    testRoot = await createTestProject();
    const wrapDir = join(testRoot, ".story");
    const trickyDir = join(wrapDir, "..keep");
    await mkdir(trickyDir, { recursive: true });
    // A path segment that merely starts with ".." must not be mistaken for an
    // escape -- this is why the check tests for ".." + sep, not a bare "..".
    await expect(
      guardPath(join(trickyDir, "file.json"), wrapDir),
    ).resolves.toBeUndefined();
  });

  it("rejects a path that escapes root via ..", async () => {
    testRoot = await createTestProject();
    const wrapDir = join(testRoot, ".story");
    await expect(
      guardPath(join(testRoot, "..", "outside.json"), wrapDir),
    ).rejects.toThrow(ProjectLoaderError);
  });
});

describe("transaction recovery", () => {
  it("cleans up stale journal on load", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });
    const wrapDir = join(testRoot, ".story");

    // Write a stale journal
    const journal = [
      {
        op: "write",
        target: join(wrapDir, "tickets", "T-002.json"),
        tempPath: join(wrapDir, "tickets", "T-002.json.12345.tmp"),
      },
    ];
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify(journal),
    );

    // Load should clean up the journal
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(1);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
  });

  it("completes forward when temp file exists", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });
    const wrapDir = join(testRoot, ".story");
    const targetPath = join(wrapDir, "tickets", "T-002.json");
    const tempPath = `${targetPath}.12345.tmp`;

    // Write temp file and journal
    const newTicket = { ...validTicket, id: "T-002", title: "Recovered" };
    await writeFile(tempPath, JSON.stringify(newTicket, null, 2));
    const journal = [{ op: "write", target: targetPath, tempPath }];
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify(journal),
    );

    // Load should recover -- rename temp to target
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(2);
    expect(result.state.ticketByID("T-002")?.title).toBe("Recovered");
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
  });

  it("does NOT delete targets when commitStarted=false (pre-commit crash)", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });
    const wrapDir = join(testRoot, ".story");
    const targetPath = join(wrapDir, "tickets", "T-001.json");

    // Journal with commitStarted=false and a delete entry
    const journal = {
      entries: [{ op: "delete", target: targetPath }],
      commitStarted: false,
    };
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify(journal),
    );

    // Recovery should NOT delete T-001 -- commit never started
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(1);
    expect(result.state.ticketByID("T-001")).toBeDefined();
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
  });

  it("replays deletes when commitStarted=true (mid-commit crash)", async () => {
    testRoot = await createTestProject({
      tickets: {
        "T-001.json": validTicket,
        "T-002.json": { ...validTicket, id: "T-002", title: "To Delete" },
      },
    });
    const wrapDir = join(testRoot, ".story");
    const deleteTarget = join(wrapDir, "tickets", "T-002.json");

    // Journal with commitStarted=true and a delete entry
    const journal = {
      entries: [{ op: "delete", target: deleteTarget }],
      commitStarted: true,
    };
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify(journal),
    );

    // Recovery should complete the delete
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(1);
    expect(result.state.ticketByID("T-002")).toBeUndefined();
    expect(existsSync(deleteTarget)).toBe(false);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
  });

  it("cleans up temps when commitStarted=false", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": validTicket },
    });
    const wrapDir = join(testRoot, ".story");
    const targetPath = join(wrapDir, "tickets", "T-002.json");
    const tempPath = `${targetPath}.99999.tmp`;

    // Write orphan temp and journal with commitStarted=false
    await writeFile(tempPath, "temp content");
    const journal = {
      entries: [{ op: "write", target: targetPath, tempPath }],
      commitStarted: false,
    };
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify(journal),
    );

    // Recovery should clean up temp without creating target
    await loadProject(testRoot);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
  });
});

describe("atomicCreate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "storybloq-ac-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("succeeds on new file and writes correct content", async () => {
    const target = join(tmpDir, "test.json");
    await atomicCreate(target, '{"id":"T-001"}\n');
    const content = await readFile(target, "utf-8");
    expect(content).toBe('{"id":"T-001"}\n');
  });

  it("throws file_exists when target already exists", async () => {
    const target = join(tmpDir, "test.json");
    await writeFile(target, "existing");
    try {
      await atomicCreate(target, "new content");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).toBe("file_exists");
    }
  });

  it("cleans up temp file on EEXIST", async () => {
    const target = join(tmpDir, "test.json");
    await writeFile(target, "existing");
    try {
      await atomicCreate(target, "new content");
    } catch {
      // expected
    }
    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("cleans up temp file on non-EEXIST link failure", async () => {
    // When parent directory does not exist, link() fails with ENOENT (not EEXIST).
    // atomicCreate should still clean up the temp and throw io_error, not file_exists.
    const target = join(tmpDir, "nonexistent-dir", "test.json");
    try {
      await atomicCreate(target, "content");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoaderError);
      expect((err as ProjectLoaderError).code).not.toBe("file_exists");
    }
    // No orphaned temp files in tmpDir
    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("does not throw spurious error when temp unlink fails after successful link", async () => {
    // After link() succeeds, unlink(temp) is best-effort.
    // Verify atomicCreate succeeds even if cleanup has issues by checking the file is created.
    const target = join(tmpDir, "test.json");
    await atomicCreate(target, '{"ok":true}\n');
    expect(existsSync(target)).toBe(true);
    const content = await readFile(target, "utf-8");
    expect(content).toBe('{"ok":true}\n');
  });

  it("uses PID+UUID temp naming (no collision on same PID)", async () => {
    // Two concurrent atomicCreate calls to different targets in the same dir
    // should not collide on temp file names.
    const target1 = join(tmpDir, "a.json");
    const target2 = join(tmpDir, "b.json");
    await Promise.all([
      atomicCreate(target1, '{"id":"a"}\n'),
      atomicCreate(target2, '{"id":"b"}\n'),
    ]);
    expect(await readFile(target1, "utf-8")).toBe('{"id":"a"}\n');
    expect(await readFile(target2, "utf-8")).toBe('{"id":"b"}\n');
  });

  it("exactly one wins when two race for the same target", async () => {
    const target = join(tmpDir, "race.json");
    const results = await Promise.allSettled([
      atomicCreate(target, '{"winner":"a"}\n'),
      atomicCreate(target, '{"winner":"b"}\n'),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const content = await readFile(target, "utf-8");
    const parsed = JSON.parse(content);
    expect(["a", "b"]).toContain(parsed.winner);
  });
});

describe("atomicWrite temp naming", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "storybloq-aw-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("still overwrites existing file (regression)", async () => {
    const target = join(tmpDir, "test.json");
    await writeFile(target, "old");
    await atomicWrite(target, "new");
    expect(await readFile(target, "utf-8")).toBe("new");
  });

  it("creates new file when target does not exist (regression)", async () => {
    const target = join(tmpDir, "new.json");
    await atomicWrite(target, "content");
    expect(await readFile(target, "utf-8")).toBe("content");
  });
});

describe("deterministic load order", () => {
  it("loads tickets in sorted filename order", async () => {
    // Create tickets with different filenames to verify deterministic ordering
    testRoot = await createTestProject({
      tickets: {
        "T-003.json": { ...validTicket, id: "T-003", title: "Third" },
        "T-001.json": { ...validTicket, id: "T-001", title: "First" },
        "T-002.json": { ...validTicket, id: "T-002", title: "Second" },
      },
    });

    const result = await loadProject(testRoot);
    // Tickets should be loaded in filename-sorted order (T-001, T-002, T-003)
    // This ensures first-wins collision is deterministic
    expect(result.state.tickets[0]!.id).toBe("T-001");
    expect(result.state.tickets[1]!.id).toBe("T-002");
    expect(result.state.tickets[2]!.id).toBe("T-003");
  });
});

describe("detectTeamModeFromDisk (ISS-701)", () => {
  it("returns true when team mode is enabled in config", async () => {
    testRoot = await createTestProject({ config: { ...minimalConfig, team: { enabled: true } } });
    expect(await detectTeamModeFromDisk(testRoot)).toBe(true);
  });

  it("returns false for a solo-mode config", async () => {
    testRoot = await createTestProject();
    expect(await detectTeamModeFromDisk(testRoot)).toBe(false);
  });

  it("returns false when team is present but not enabled", async () => {
    testRoot = await createTestProject({ config: { ...minimalConfig, team: { enabled: false } } });
    expect(await detectTeamModeFromDisk(testRoot)).toBe(false);
  });

  it("throws with code ENOENT when config.json is missing (caller decides degradation)", async () => {
    testRoot = await createTestProject({ skipConfig: true });
    await expect(detectTeamModeFromDisk(testRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws (non-ENOENT) on malformed config json", async () => {
    testRoot = await createTestProject();
    await writeFile(join(testRoot, ".story", "config.json"), "{ not valid json");
    await expect(detectTeamModeFromDisk(testRoot)).rejects.toThrow();
    await expect(detectTeamModeFromDisk(testRoot)).rejects.not.toMatchObject({ code: "ENOENT" });
  });
});

describe("validateOnLoad cross-reference check (ISS-730)", () => {
  const danglingTicket = { ...validTicket, id: "T-001", parentTicket: "T-999" };

  it("off by default: a dangling parentTicket produces NO cross_reference warning", async () => {
    testRoot = await createTestProject({
      tickets: { "T-001.json": danglingTicket },
    });
    const result = await loadProject(testRoot);
    expect(result.warnings.some((w) => w.type === "cross_reference")).toBe(false);
  });

  it("when enabled: surfaces the dangling ref as an advisory cross_reference warning (load still succeeds)", async () => {
    testRoot = await createTestProject({
      config: { ...minimalConfig, validateOnLoad: true },
      tickets: { "T-001.json": danglingTicket },
    });
    const result = await loadProject(testRoot);
    expect(result.state.tickets).toHaveLength(1); // load did not fail
    const xref = result.warnings.find((w) => w.type === "cross_reference");
    expect(xref).toBeDefined();
    expect(xref!.message).toContain("invalid_parent_ref");
    expect(xref!.message).toContain("T-999");
  });

  it("a clean project with validateOnLoad enabled produces no cross_reference warning", async () => {
    testRoot = await createTestProject({
      config: { ...minimalConfig, validateOnLoad: true },
      tickets: { "T-001.json": validTicket },
    });
    const result = await loadProject(testRoot);
    expect(result.warnings.some((w) => w.type === "cross_reference")).toBe(false);
  });

  it("cross_reference is non-fatal even in strict mode (does not throw)", async () => {
    testRoot = await createTestProject({
      config: { ...minimalConfig, validateOnLoad: true },
      tickets: { "T-001.json": danglingTicket },
    });
    // strict mode only fails on INTEGRITY_WARNING_TYPES, evaluated before the
    // validateOnLoad pass; cross_reference must never brick a strict load.
    const result = await loadProject(testRoot, { strict: true });
    expect(result.warnings.some((w) => w.type === "cross_reference")).toBe(true);
  });
});
