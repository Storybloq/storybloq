import { describe, it, expect } from "vitest";
import { mergeConfig } from "../../src/core/merge-driver.js";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    project: "test-project",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...overrides,
  };
}

describe("T-387: mergeConfig", () => {
  describe("scalar keys (standard three-way)", () => {
    it("takes changed side when only one side changes version", () => {
      const base = config({ version: 2 });
      const ours = config({ version: 2 });
      const theirs = config({ version: 3 });
      const result = mergeConfig(base, ours, theirs);
      expect(result.merged.version).toBe(3);
      expect(result.clean).toBe(true);
    });

    it("conflicts when both sides change project differently", () => {
      const base = config({ project: "alpha" });
      const ours = config({ project: "beta" });
      const theirs = config({ project: "gamma" });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/project")).toBe(true);
      expect(result.merged.project).toBe("beta");
    });
  });

  describe("deep merge nested objects", () => {
    // ISS-1012: statusWriter is a nested root object, so it must be on the
    // deep-merge allowlist -- otherwise two teammates touching different keys
    // inside it conflict at the whole-object level, which is exactly what the
    // "room to grow" shape was chosen to avoid.
    it("field-merges statusWriter instead of conflicting on the whole object", () => {
      const base = config({ statusWriter: { stopHook: true } });
      const ours = config({ statusWriter: { stopHook: false } });
      const theirs = config({ statusWriter: { stopHook: true, enabled: false } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged.statusWriter).toEqual({ stopHook: false, enabled: false });
    });

    it("merges disjoint nested keys cleanly", () => {
      const base = config({ recipeOverrides: { maxTicketsPerSession: 5 } });
      const ours = config({ recipeOverrides: { maxTicketsPerSession: 5, branchStrategy: "per-ticket" } });
      const theirs = config({ recipeOverrides: { maxTicketsPerSession: 5, handoverInterval: 3 } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      const ro = result.merged.recipeOverrides as Record<string, unknown>;
      expect(ro.maxTicketsPerSession).toBe(5);
      expect(ro.branchStrategy).toBe("per-ticket");
      expect(ro.handoverInterval).toBe(3);
    });

    it("convergent addition: both add team with same content = clean", () => {
      const base = config();
      const team = { idAllocator: "git-refs", minCliVersion: "1.0.0" };
      const ours = config({ team });
      const theirs = config({ team });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged.team).toEqual(team);
    });

    it("conflicts on same nested key with different values", () => {
      const base = config({ team: { idAllocator: "local" } });
      const ours = config({ team: { idAllocator: "git-refs" } });
      const theirs = config({ team: { idAllocator: "central" } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(false);
      const conflict = result.conflicts.find((c) => c.fieldPath === "/team/idAllocator");
      expect(conflict).toBeDefined();
      expect(conflict!.base).toBe("local");
      expect(conflict!.ours).toBe("git-refs");
      expect(conflict!.theirs).toBe("central");
    });
  });

  describe("nested key deletion", () => {
    it("delete vs unchanged = delete", () => {
      const base = config({ team: { idAllocator: "local", minCliVersion: "1.0.0" } });
      const ours = config({ team: { idAllocator: "local" } });
      const theirs = config({ team: { idAllocator: "local", minCliVersion: "1.0.0" } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      const team = result.merged.team as Record<string, unknown>;
      expect("minCliVersion" in team).toBe(false);
    });

    it("delete vs edit = conflict", () => {
      const base = config({ team: { idAllocator: "local", minCliVersion: "1.0.0" } });
      const ours = config({ team: { idAllocator: "local" } });
      const theirs = config({ team: { idAllocator: "local", minCliVersion: "2.0.0" } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/team/minCliVersion")).toBe(true);
    });
  });

  describe("type changes", () => {
    it("one-sided type change on unknown key: string to object = take changed side", () => {
      const base = config({ customKey: "simple" });
      const ours = config({ customKey: "simple" });
      const theirs = config({ customKey: { nested: true } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged.customKey).toEqual({ nested: true });
    });

    it("both-sided type change on unknown key: different types = conflict", () => {
      const base = config({ customKey: "simple" });
      const ours = config({ customKey: { nested: true } });
      const theirs = config({ customKey: 42 });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/customKey")).toBe(true);
    });

    it("known object key with non-object value throws", () => {
      const base = config({ federation: { allowNodeWrites: false } });
      const ours = config({ federation: "invalid" });
      const theirs = config({ federation: { allowNodeWrites: true } });
      expect(() => mergeConfig(base, ours, theirs)).toThrow();
    });
  });

  describe("nodes (object-keyed merge)", () => {
    it("both add different nodes = auto-merge", () => {
      const base = config({ nodes: {} });
      const ours = config({ nodes: { engine: { path: "~/engine", role: "core" } } });
      const theirs = config({ nodes: { web: { path: "~/web", role: "frontend" } } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      const nodes = result.merged.nodes as Record<string, unknown>;
      expect(nodes.engine).toEqual({ path: "~/engine", role: "core" });
      expect(nodes.web).toEqual({ path: "~/web", role: "frontend" });
    });

    it("same node different content = conflict", () => {
      const base = config({ nodes: { engine: { path: "~/engine", health: "green" } } });
      const ours = config({ nodes: { engine: { path: "~/engine", health: "yellow" } } });
      const theirs = config({ nodes: { engine: { path: "~/engine", health: "red" } } });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/nodes/engine/health")).toBe(true);
    });
  });

  describe("unknown top-level keys", () => {
    it("three-way merge for unknown scalar key", () => {
      const base = config({ customSetting: "old" });
      const ours = config({ customSetting: "old" });
      const theirs = config({ customSetting: "new" });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged.customSetting).toBe("new");
    });
  });

  describe("_conflicts handling", () => {
    it("drops base-only (resolved) _conflicts", () => {
      const base = config({ _conflicts: [{ fieldPath: "/stale", kind: "field" }] });
      const ours = config();
      const theirs = config();
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged._conflicts).toBeUndefined();
    });

    it("carries forward an unresolved entry present in base+ours+theirs across an unrelated clean merge (ISS-750)", () => {
      const entry = { fieldPath: "/project", field: "project", kind: "field", base: "alpha", ours: "beta", theirs: "gamma" };
      const base = config({ _conflicts: [entry] });
      const ours = config({ _conflicts: [entry] });
      const theirs = config({ language: "python", _conflicts: [entry] });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged.language).toBe("python");
      const carried = result.merged._conflicts as Array<Record<string, unknown>>;
      expect(Array.isArray(carried)).toBe(true);
      expect(carried.some((c) => c.fieldPath === "/project")).toBe(true);
    });

    it("carries forward an entry present in ours+theirs (concluded conflicted merge on both lines)", () => {
      const entry = { fieldPath: "/project", field: "project", kind: "field", base: "alpha", ours: "beta", theirs: "gamma" };
      const base = config();
      const ours = config({ _conflicts: [entry] });
      const theirs = config({ _conflicts: [entry] });
      const result = mergeConfig(base, ours, theirs);
      expect(result.clean).toBe(true);
      const carried = result.merged._conflicts as Array<Record<string, unknown>>;
      expect(Array.isArray(carried)).toBe(true);
      expect(carried).toHaveLength(1);
    });
  });
});
