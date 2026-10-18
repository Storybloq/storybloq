/**
 * T-538 S2: the quality matrix (plan v5 5b), stage 1's explicit table from
 * setup-flow.md step 3, encoded once. Setup (`computeInitialStages`) and a
 * later establishment (`establishStage`) both read `STAGE_MATRIX`; there is
 * no derived predicate.
 *
 * | Level      | WRITE_TESTS                    | TEST                  | BUILD               | VERIFY                            |
 * |------------|--------------------------------|-----------------------|---------------------|-----------------------------------|
 * | minimal    | written, off                   | written, off          | written, off        | written, off                      |
 * | tests-only | written with the command, off  | on when a test is sat | off                 | off                               |
 * | full       | on when a test is satisfied    | on when a test is sat | on when build is sat| on when it applies and is sat     |
 *
 * A component's stage is satisfied when it is `established` (setup found
 * working evidence) or `verified` (a passing setup-verify). `pending` and
 * `left-off` are not.
 */
import { posix } from "node:path";
import type { QualityLevel } from "./setup-payload.js";

export type StageEvidenceStatus = "established" | "verified" | "pending" | "left-off";

export interface CommandEvidence {
  readonly command: string;
  readonly status: StageEvidenceStatus;
  readonly reason?: string;
}

export interface VerifyEvidence {
  readonly startCommand: string;
  readonly readinessUrl: string;
  readonly status: StageEvidenceStatus;
  readonly reason?: string;
}

export interface ActivationComponent {
  readonly id: string;
  readonly workdir: string;
  readonly test: CommandEvidence | null;
  readonly build: CommandEvidence | null;
  readonly verify: VerifyEvidence | null;
}

export interface ActivationInput {
  readonly level: QualityLevel;
  readonly verifyApplies: boolean;
  readonly components: readonly ActivationComponent[];
}

export type RecipeStage = "WRITE_TESTS" | "TEST" | "BUILD" | "VERIFY";
export type ComponentStage = "test" | "build" | "verify";

/** When a recipe stage is enabled, per level: never, or when its component stage has a satisfied component. */
type Rule = "off" | "satisfied";

export const STAGE_MATRIX: Readonly<Record<QualityLevel, Readonly<Record<RecipeStage, Rule>>>> = {
  minimal: { WRITE_TESTS: "off", TEST: "off", BUILD: "off", VERIFY: "off" },
  "tests-only": { WRITE_TESTS: "off", TEST: "satisfied", BUILD: "off", VERIFY: "off" },
  full: { WRITE_TESTS: "satisfied", TEST: "satisfied", BUILD: "satisfied", VERIFY: "satisfied" },
};

/** The recipe stages each component stage serves; a test component serves the shared WRITE_TESTS/TEST command. */
export const SERVES: Readonly<Record<ComponentStage, readonly RecipeStage[]>> = {
  test: ["WRITE_TESTS", "TEST"],
  build: ["BUILD"],
  verify: ["VERIFY"],
};

/** The recipe stages a level uses, and so owes a pending line for (stage 1's pendingInventory, plus BUILD and VERIFY under full). */
export const STAGES_USED: Readonly<Record<QualityLevel, readonly RecipeStage[]>> = {
  minimal: [],
  "tests-only": ["TEST"],
  full: ["WRITE_TESTS", "TEST", "BUILD", "VERIFY"],
};

export interface PendingStageLine {
  readonly stage: RecipeStage;
  /** The component's id when the project has several components, else null. */
  readonly component: string | null;
  readonly command: string;
  readonly reason: string;
}

export type StagesConfig = Record<string, Record<string, unknown>>;

const satisfied = (status: StageEvidenceStatus) => status === "established" || status === "verified";

function dirOf(workdir: string): string {
  const n = posix.normalize(workdir).replace(/\/+$/, "");
  return n === "" ? "." : n;
}

/** One shell word, single-quoted: an embedded `'` becomes `'\''`, so nothing in it is expanded or run. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

type Step = { readonly workdir: string; readonly command: string };

/**
 * Stage 1's test command, whose grammar check set 4 grades: each step run
 * from its component's directory, joined only by `&&`, with a plain `cd`
 * between directories (`cd 'frontend' && npm test && cd '../backend' &&
 * pytest`), in payload order. Every workdir is quoted; the payload refuses a
 * test command that could move the shell (`testCommandProblem`).
 */
export function chainCommand(steps: readonly Step[]): string {
  const parts: string[] = [];
  let cwd = ".";
  for (const step of steps) {
    const dir = dirOf(step.workdir);
    if (dir !== cwd) {
      parts.push(`cd ${shellQuote(posix.relative(posix.join("/", cwd), posix.join("/", dir)))}`);
      cwd = dir;
    }
    parts.push(step.command);
  }
  return parts.join(" && ");
}

/**
 * BUILD and VERIFY commands, which no grammar grades: each component runs in
 * its own subshell from its quoted workdir, `(cd '<dir>' && (<command>))`,
 * joined by `&&`, so a command that changes directory cannot move the next.
 * A lone root command is written as it is.
 */
export function wrappedCommand(steps: readonly Step[]): string {
  if (steps.length === 1 && dirOf(steps[0]!.workdir) === ".") return steps[0]!.command;
  return steps.map((s) => `(cd ${shellQuote(dirOf(s.workdir))} && (${s.command}))`).join(" && ");
}

function commandStage(input: ActivationInput, of: "test" | "build", rule: Rule): { enabled: boolean; command: string | null } {
  const all = input.components.flatMap((c) => (c[of] ? [{ workdir: c.workdir, ...c[of]! }] : []));
  const ready = all.filter((s) => satisfied(s.status));
  const join = of === "test" ? chainCommand : wrappedCommand;
  // The established components only; with none, the proposed command, written off.
  const command = ready.length > 0 ? join(ready) : all.length > 0 ? join(all) : null;
  return { enabled: rule === "satisfied" && ready.length > 0, command };
}

function buildStage(input: ActivationInput, stage: RecipeStage): Record<string, unknown> {
  const rule = STAGE_MATRIX[input.level][stage];
  if (stage === "VERIFY") {
    // The guide starts VERIFY from the root and has no cwd field, so the start command carries its component's workdir.
    const owner = input.components.find((c) => c.verify !== null);
    const verify = owner?.verify ?? null;
    const enabled = rule === "satisfied" && input.verifyApplies && verify !== null && satisfied(verify.status);
    if (!owner || !verify) return { enabled };
    return { enabled, startCommand: wrappedCommand([{ workdir: owner.workdir, command: verify.startCommand }]), readinessUrl: verify.readinessUrl };
  }
  const { enabled, command } = commandStage(input, stage === "BUILD" ? "build" : "test", rule);
  const out: Record<string, unknown> = { enabled };
  if (command !== null) out.command = command;
  if (stage === "WRITE_TESTS") out.onExhaustion = "plan";
  return out;
}

function pendingLines(input: ActivationInput): PendingStageLine[] {
  const several = input.components.length > 1;
  const lines: PendingStageLine[] = [];
  for (const stage of STAGES_USED[input.level]) {
    if (stage === "VERIFY" && !input.verifyApplies) continue;
    for (const c of input.components) {
      const ev = stage === "VERIFY" ? c.verify : stage === "BUILD" ? c.build : c.test;
      if (ev === null || ev.status !== "pending") continue;
      const command = "command" in ev ? ev.command : ev.startCommand;
      lines.push({ stage, component: several ? c.id : null, command, reason: ev.reason ?? "pending" });
    }
  }
  return lines;
}

/** Every recipe stage, written with an explicit `enabled`, plus the pending lines the level owes. */
export function computeInitialStages(input: ActivationInput): { stages: StagesConfig; pending: PendingStageLine[] } {
  const stages: StagesConfig = {};
  for (const stage of ["WRITE_TESTS", "TEST", "BUILD", "VERIFY"] as const) stages[stage] = buildStage(input, stage);
  return { stages, pending: pendingLines(input) };
}

/**
 * One component stage became `verified`: rebuild only the recipe stages it
 * serves (their command and `enabled`, from the same table), keeping every
 * other field of those stages and every other stage byte-equal.
 */
export function establishStage(
  input: ActivationInput,
  current: StagesConfig,
  componentId: string,
  of: ComponentStage,
): { input: ActivationInput; stages: StagesConfig } {
  const target = input.components.find((c) => c.id === componentId);
  if (!target) throw new Error(`No component ${componentId} in this setup.`);
  if (target[of] === null) throw new Error(`Component ${componentId} has no ${of} stage to establish.`);
  const next: ActivationInput = {
    ...input,
    components: input.components.map((c) => (c.id === componentId ? { ...c, [of]: { ...c[of]!, status: "verified" } } : c)),
  };
  const stages: StagesConfig = { ...current };
  for (const stage of SERVES[of]) {
    const rebuilt = buildStage(next, stage);
    const merged: Record<string, unknown> = { ...(current[stage] ?? {}) };
    for (const field of ["enabled", "command", "startCommand", "readinessUrl"]) {
      if (field in rebuilt) merged[field] = rebuilt[field];
    }
    if (stage === "WRITE_TESTS" && !("onExhaustion" in merged)) merged.onExhaustion = "plan";
    stages[stage] = merged;
  }
  return { input: next, stages };
}
