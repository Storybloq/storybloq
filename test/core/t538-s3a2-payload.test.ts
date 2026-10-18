/**
 * T-538 S3a-2 commit 1: the establishment in the setup payload. A pending
 * test component names its runner and wrapper; one establishment ticket per
 * component waits on its scaffold alone, carries no status, and never waits
 * on another establishment, on the effective graph (gates included).
 */
import { describe, it, expect } from "vitest";
import { usesEstablishment, validateSetupPayload } from "../../src/core/setup-payload.js";

const SID = "SS-0123abcd";

type T = { key: string; title: string; type: string; phase: string; description: string; blockedBy: string[]; status?: string; establishes?: unknown };

const t = (key: string, blockedBy: string[], extra: Partial<T> = {}): T => ({ key, title: key, type: "task", phase: "K1", description: "", blockedBy, ...extra });
const est = (key: string, scaffold: string, component = "app", blockedBy = [scaffold]): T =>
  t(key, blockedBy, { establishes: { component, stage: "test", scaffold } });
const cp = (key: string, blockedBy: string[], gates: string[]) => ({ key, title: key, kind: "acceptance", criteria: "c", evidenceRefs: [], description: "", phase: "K1", blockedBy, gates });

const comp = (id: string, test: Record<string, unknown> | null = { command: "npm test", status: "pending", reason: "no tests yet", runner: "vitest", wrapper: "npm" }) =>
  ({ id, workdir: id === "app" ? "." : id, test, build: null, verify: null });

function payload(over: { tickets?: T[]; checkpoints?: unknown[]; components?: unknown[] } = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: { level: "tests-only", verifyApplies: false, components: over.components ?? [comp("app")] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [] },
    git: { init: false, gitignore: [] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "" }],
    tickets: over.tickets ?? [t("K2", []), est("K3", "K2"), t("K4", ["K3"])],
    checkpoints: over.checkpoints ?? [],
    issues: [],
    coverage: [{ requirement: "R1", text: "x", source: "brief", keys: ["K2"] }],
  };
}

const refusal = (p: Record<string, unknown>): string => {
  try {
    validateSetupPayload(p);
  } catch (err) {
    return (err as Error).message;
  }
  return "accepted";
};

describe("the establishment payload", () => {
  it("accepts a scaffold, its establishment and work after it, and keeps the fields", () => {
    const parsed = validateSetupPayload(payload());
    expect(parsed.tickets[1]!.establishes).toEqual({ component: "app", stage: "test", scaffold: "K2" });
    expect(parsed.quality.components[0]!.test).toMatchObject({ runner: "vitest", wrapper: "npm" });
    expect(usesEstablishment(parsed)).toBe(true);
  });

  it("is opt-in: a payload without one does not use it", () => {
    expect(usesEstablishment(validateSetupPayload(payload({ tickets: [t("K2", [])] })))).toBe(false);
  });

  it("refuses an unknown runner or wrapper, and a runner on a build stage", () => {
    expect(refusal(payload({ components: [comp("app", { command: "npm test", status: "pending", reason: "r", runner: "mocha", wrapper: "npm" })] }))).toMatch(/runner/);
    expect(refusal(payload({ components: [comp("app", { command: "npm test", status: "pending", reason: "r", runner: "vitest", wrapper: "yarn" })] }))).toMatch(/wrapper/);
    const build = { ...comp("app"), build: { command: "npm run build", status: "established", runner: "vitest" } };
    expect(refusal(payload({ components: [build] }))).toMatch(/runner|Unrecognized/);
  });

  it("refuses a component that does not exist", () => {
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K2", "web")] }))).toMatch(/K3 establishes component web, which is not a component/);
  });

  it("refuses a test stage that is not pending, or absent", () => {
    const established = comp("app", { command: "npm test", status: "established", runner: "vitest", wrapper: "npm" });
    expect(refusal(payload({ components: [established] }))).toMatch(/which is not pending/);
    expect(refusal(payload({ components: [comp("app", null)] }))).toMatch(/which is not pending/);
  });

  it("refuses a pending test stage that names no runner or no wrapper", () => {
    expect(refusal(payload({ components: [comp("app", { command: "npm test", status: "pending", reason: "r", wrapper: "npm" })] }))).toMatch(/names no runner and wrapper/);
    expect(refusal(payload({ components: [comp("app", { command: "npm test", status: "pending", reason: "r", runner: "vitest" })] }))).toMatch(/names no runner and wrapper/);
  });

  it("refuses two establishment tickets for one component", () => {
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K2"), est("K4", "K2")] }))).toMatch(/K3 and K4 both establish app's test stage/);
  });

  it("refuses an establishment ticket that is not a task", () => {
    expect(refusal(payload({ tickets: [t("K2", []), { ...est("K3", "K2"), type: "feature" }] }))).toMatch(/K3 is an establishment ticket and must be a task/);
  });

  it("refuses any explicit status on an establishment ticket, open included", () => {
    for (const status of ["open", "complete"]) {
      expect(refusal(payload({ tickets: [t("K2", []), { ...est("K3", "K2"), status }] }))).toMatch(/K3 is an establishment ticket and carries no status/);
    }
  });

  it("refuses a scaffold that is not a ticket, is an establishment, or is complete", () => {
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K9", "app", ["K2"])] }))).toMatch(/scaffold K9 is not a ticket key/);
    const two = [comp("app"), comp("api")];
    expect(refusal(payload({ components: two, tickets: [t("K2", []), est("K3", "K2"), est("K4", "K3", "api")] }))).toMatch(/K4's scaffold K3 is itself an establishment ticket/);
    expect(refusal(payload({ tickets: [t("K2", [], { status: "complete" }), est("K3", "K2")] }))).toMatch(/K3's scaffold K2 is already complete/);
  });

  it("refuses an establishment that waits on anything but its scaffold, a gate included", () => {
    expect(refusal(payload({ tickets: [t("K2", []), t("K5", []), est("K3", "K2", "app", ["K2", "K5"])] }))).toMatch(/K3 waits on K5; an establishment ticket waits on its scaffold K2 alone/);
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K2")], checkpoints: [cp("K6", [], ["K3"])] }))).toMatch(/K3 waits on K6; an establishment ticket waits on its scaffold K2 alone/);
  });

  it("refuses an establishment that does not wait on its scaffold", () => {
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K2", "app", [])] }))).toMatch(/K3 does not wait on its scaffold K2/);
  });

  it("refuses a scaffold that waits on its own establishment", () => {
    expect(refusal(payload({ tickets: [t("K2", ["K3"]), est("K3", "K2")] }))).toMatch(/K3's scaffold K2 waits on K3/);
  });

  it("refuses a scaffold that waits on its establishment through a gate", () => {
    expect(refusal(payload({ tickets: [t("K2", []), est("K3", "K2")], checkpoints: [cp("K6", ["K3"], ["K2"])] }))).toMatch(/K3's scaffold K2 waits on K3/);
  });

  it("refuses the acyclic cross-component deadlock: a scaffold that waits on another establishment", () => {
    const two = [comp("app"), comp("api")];
    const tickets = [t("K2", []), est("K3", "K2"), t("K4", ["K3"]), est("K5", "K4", "api")];
    expect(refusal(payload({ components: two, tickets }))).toMatch(/K5 waits on K3, which is an establishment ticket/);
  });

  it("refuses the deadlock transitively, and through a gate", () => {
    const two = [comp("app"), comp("api")];
    const transitive = [t("K2", []), est("K3", "K2"), t("K7", ["K3"]), t("K4", ["K7"]), est("K5", "K4", "api")];
    expect(refusal(payload({ components: two, tickets: transitive }))).toMatch(/K5 waits on K3, which is an establishment ticket/);
    const gated = [t("K2", []), est("K3", "K2"), t("K4", []), est("K5", "K4", "api")];
    expect(refusal(payload({ components: two, tickets: gated, checkpoints: [cp("K6", ["K3"], ["K4"])] }))).toMatch(/K5 waits on K3, which is an establishment ticket/);
  });

  it("accepts two components established independently", () => {
    const two = [comp("app"), comp("api")];
    const tickets = [t("K2", []), est("K3", "K2"), t("K4", ["K2"]), est("K5", "K4", "api"), t("K8", ["K3", "K5"])];
    expect(refusal(payload({ components: two, tickets }))).toBe("accepted");
  });
});
