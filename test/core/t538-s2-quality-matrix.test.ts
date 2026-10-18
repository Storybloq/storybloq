/**
 * T-538 S2 commit 2: the quality matrix (plan v5 5b). Every cell is asserted
 * on its own, for each level, through both callers: setup's
 * `computeInitialStages` and the later `establishStage`.
 */
import { describe, it, expect } from "vitest";
import {
  chainCommand,
  computeInitialStages,
  establishStage,
  type ActivationComponent,
  type ActivationInput,
  type RecipeStage,
  type StageEvidenceStatus,
} from "../../src/core/verification-activation.js";
import type { QualityLevel } from "../../src/core/setup-payload.js";

const LEVELS: readonly QualityLevel[] = ["minimal", "tests-only", "full"];
const STAGES: readonly RecipeStage[] = ["WRITE_TESTS", "TEST", "BUILD", "VERIFY"];

/** Stage 1's table: whether each stage is on once its component stage is satisfied. */
const ON_WHEN_SATISFIED: Record<QualityLevel, Record<RecipeStage, boolean>> = {
  minimal: { WRITE_TESTS: false, TEST: false, BUILD: false, VERIFY: false },
  "tests-only": { WRITE_TESTS: false, TEST: true, BUILD: false, VERIFY: false },
  full: { WRITE_TESTS: true, TEST: true, BUILD: true, VERIFY: true },
};

function web(status: StageEvidenceStatus): ActivationComponent {
  return {
    id: "web",
    workdir: ".",
    test: { command: "npm test", status, reason: status === "pending" ? "no test files yet" : undefined },
    build: { command: "npm run build", status, reason: status === "pending" ? "no build script yet" : undefined },
    verify: { startCommand: "npm run dev", readinessUrl: "http://localhost:3000", status, reason: status === "pending" ? "no dev script yet" : undefined },
  };
}

const input = (level: QualityLevel, components: ActivationComponent[], verifyApplies = true): ActivationInput => ({ level, verifyApplies, components });

describe("the quality matrix, cell by cell", () => {
  for (const level of LEVELS) {
    for (const stage of STAGES) {
      const expected = ON_WHEN_SATISFIED[level][stage];
      it(`${level} ${stage}: at setup, established ${expected ? "on" : "off"}, pending off`, () => {
        expect(computeInitialStages(input(level, [web("established")])).stages[stage]!.enabled).toBe(expected);
        expect(computeInitialStages(input(level, [web("pending")])).stages[stage]!.enabled).toBe(false);
      });
      it(`${level} ${stage}: after establishment, ${expected ? "on" : "off"}`, () => {
        let state = input(level, [web("pending")]);
        let stages = computeInitialStages(state).stages;
        for (const of of ["test", "build", "verify"] as const) ({ input: state, stages } = establishStage(state, stages, "web", of));
        expect(stages[stage]!.enabled).toBe(expected);
      });
    }
  }

  it("every stage is written with an explicit enabled, and the test command is written even when off", () => {
    for (const level of LEVELS) {
      const { stages } = computeInitialStages(input(level, [web("established")]));
      expect(Object.keys(stages).sort()).toEqual([...STAGES].sort());
      for (const stage of STAGES) expect(typeof stages[stage]!.enabled).toBe("boolean");
      expect(stages.WRITE_TESTS).toMatchObject({ command: "npm test", onExhaustion: "plan" });
      expect(stages.TEST).toMatchObject({ command: "npm test" });
    }
  });

  it("VERIFY stays off under full when the project type does not apply", () => {
    expect(computeInitialStages(input("full", [web("established")], false)).stages.VERIFY!.enabled).toBe(false);
  });

  it("a left-off component is not satisfied", () => {
    expect(computeInitialStages(input("full", [web("left-off")])).stages.TEST!.enabled).toBe(false);
  });
});

describe("several components", () => {
  const frontend: ActivationComponent = { id: "frontend", workdir: "frontend", test: { command: "npm test", status: "established" }, build: null, verify: null };
  const backend: ActivationComponent = { id: "backend", workdir: "backend/", test: { command: "pytest", status: "pending", reason: "no test files yet" }, build: null, verify: null };

  it("an established frontend and a pending backend turn TEST on with the frontend command; verifying the backend adds it and changes nothing else", () => {
    const setup = input("full", [frontend, backend]);
    const initial = computeInitialStages(setup);
    expect(initial.stages.TEST).toEqual({ enabled: true, command: "cd frontend && npm test" });
    const current = { ...initial.stages, WRITE_TESTS: { ...initial.stages.WRITE_TESTS!, onExhaustion: "stop", maxRetries: 2 }, LINT: { enabled: true } };
    const after = establishStage(setup, current, "backend", "test");
    expect(after.stages.TEST).toEqual({ enabled: true, command: "cd frontend && npm test && cd ../backend && pytest" });
    expect(after.stages.WRITE_TESTS).toEqual({ enabled: true, command: "cd frontend && npm test && cd ../backend && pytest", onExhaustion: "stop", maxRetries: 2 });
    expect(after.stages.BUILD).toBe(current.BUILD);
    expect(after.stages.VERIFY).toBe(current.VERIFY);
    expect(after.stages.LINT).toBe(current.LINT);
  });

  it("tests only never turns WRITE_TESTS on, not even after establishment", () => {
    const setup = input("tests-only", [frontend, backend]);
    const after = establishStage(setup, computeInitialStages(setup).stages, "backend", "test");
    expect(after.stages.WRITE_TESTS).toMatchObject({ enabled: false, command: "cd frontend && npm test && cd ../backend && pytest" });
    expect(after.stages.TEST!.enabled).toBe(true);
  });

  it("each pending component gets one line per stage the level uses, named when there are several", () => {
    const lines = (level: QualityLevel) => computeInitialStages(input(level, [frontend, backend])).pending.map((l) => `${l.stage} (${l.component}): ${l.command} (pending: ${l.reason})`);
    expect(lines("full")).toEqual(["WRITE_TESTS (backend): pytest (pending: no test files yet)", "TEST (backend): pytest (pending: no test files yet)"]);
    expect(lines("tests-only")).toEqual(["TEST (backend): pytest (pending: no test files yet)"]);
    expect(lines("minimal")).toEqual([]);
    expect(computeInitialStages(input("full", [web("pending")])).pending.map((l) => [l.stage, l.component])).toEqual([
      ["WRITE_TESTS", null], ["TEST", null], ["BUILD", null], ["VERIFY", null],
    ]);
  });

  it("with no test component established, both test stages are off and carry the proposed command", () => {
    const { stages } = computeInitialStages(input("full", [{ ...frontend, test: { command: "npm test", status: "pending", reason: "r" } }, backend]));
    expect(stages.TEST).toEqual({ enabled: false, command: "cd frontend && npm test && cd ../backend && pytest" });
  });

  it("refuses to establish a component or stage the setup does not have", () => {
    const setup = input("full", [frontend, backend]);
    expect(() => establishStage(setup, {}, "mobile", "test")).toThrow(/No component mobile/);
    expect(() => establishStage(setup, {}, "backend", "build")).toThrow(/no build stage/);
  });
});

describe("the test command chain", () => {
  it.each([
    [[{ workdir: ".", command: "npm test" }], "npm test"],
    [[{ workdir: "./", command: "npm test" }, { workdir: "backend", command: "pytest" }], "npm test && cd backend && pytest"],
    [[{ workdir: "backend", command: "pytest" }, { workdir: ".", command: "npm test" }], "cd backend && pytest && cd .. && npm test"],
    [[{ workdir: "apps/web", command: "npm test" }, { workdir: "apps/api", command: "go test ./..." }], "cd apps/web && npm test && cd ../api && go test ./..."],
  ])("%j is %s", (steps, expected) => {
    expect(chainCommand(steps)).toBe(expected);
  });
});
