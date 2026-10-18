/**
 * T-538 S2 commit 1: the setup field on tickets, issues and notes, its
 * validate findings, and the progress note's setup payload.
 */
import { describe, it, expect } from "vitest";
import { parseSetupMeta } from "../../src/core/setup-meta.js";
import {
  parseSetupPayload,
  renderSetupPayload,
  validateSetupPayload,
  SETUP_PAYLOAD_MARKER,
  type SetupPayload,
} from "../../src/core/setup-payload.js";
import { validateProject } from "../../src/core/validation.js";
import { ProjectState } from "../../src/core/project-state.js";
import { makeState, makeTicket, makeIssue, makeNote } from "./test-factories.js";

const SID = "SS-0123abcd";

describe("the setup field", () => {
  it("reads an item key on a ticket or issue and a record on a note", () => {
    expect(parseSetupMeta("ticket", { setup: { setupId: SID, key: "K12" } })).toEqual({ kind: "item", meta: { setupId: SID, key: "K12" } });
    expect(parseSetupMeta("issue", { setup: { setupId: SID, key: "K9999", supersededBy: "T-004" } }).kind).toBe("item");
    expect(parseSetupMeta("note", { setup: { setupId: SID, record: "progress" } })).toEqual({ kind: "record", meta: { setupId: SID, record: "progress" } });
    expect(parseSetupMeta("note", {})).toEqual({ kind: "none" });
  });

  it.each([
    ["ticket", { setupId: SID, key: "K0" }, /item key/],
    ["ticket", { setupId: SID, key: "K10000" }, /item key/],
    ["ticket", { setupId: SID, key: "K01" }, /item key/],
    ["ticket", { setupId: "SS-XYZ", key: "K1" }, /setup id/],
    ["ticket", { setupId: SID, key: "K1", extra: true }, /extra|Unrecognized/i],
    ["ticket", { setupId: SID, record: "progress" }, /never a setup record/],
    ["issue", { setupId: SID, record: "final" }, /never a setup record/],
    ["note", { setupId: SID, key: "K1" }, /never an item key/],
    ["note", { setupId: SID, record: "handover" }, /record/],
    ["note", "SS-0123abcd", /expected object|Expected object/i],
  ] as const)("refuses a %s carrying %j", (entity, setup, reason) => {
    const parsed = parseSetupMeta(entity, { setup });
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toMatch(reason);
  });
});

describe("validate names setup-field problems", () => {
  const codes = (state: ProjectState) => validateProject(state).findings.map((f) => f.code).filter((c) => c.startsWith("setup_"));

  it("a malformed setup field is an error on its item", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001", setup: { setupId: SID, key: "K0" } } as never)] });
    const finding = validateProject(state).findings.find((f) => f.code === "setup_meta_invalid");
    expect(finding).toMatchObject({ level: "error", entity: "T-001" });
  });

  it("one key on a ticket and an issue is a duplicate naming both; a superseded holder is not", () => {
    const ticket = makeTicket({ id: "T-001", setup: { setupId: SID, key: "K3" } } as never);
    const issue = makeIssue({ id: "ISS-001", setup: { setupId: SID, key: "K3" } } as never);
    const dup = validateProject(makeState({ tickets: [ticket], issues: [issue] })).findings.find((f) => f.code === "setup_key_duplicate");
    expect(dup?.message).toContain("T-001");
    expect(dup?.message).toContain("ISS-001");
    const superseded = makeIssue({ id: "ISS-001", setup: { setupId: SID, key: "K3", supersededBy: "T-001" } } as never);
    expect(codes(makeState({ tickets: [ticket], issues: [superseded] }))).toEqual([]);
  });

  it("the same key in two setups is not a duplicate", () => {
    const a = makeTicket({ id: "T-001", setup: { setupId: SID, key: "K3" } } as never);
    const b = makeTicket({ id: "T-002", setup: { setupId: "SS-ffff0000", key: "K3" } } as never);
    expect(codes(makeState({ tickets: [a, b] }))).toEqual([]);
  });

  it("two progress notes of one setup are a record duplicate", () => {
    const a = makeNote({ id: "N-001", setup: { setupId: SID, record: "progress" } } as never);
    const b = makeNote({ id: "N-002", setup: { setupId: SID, record: "progress" } } as never);
    expect(codes(makeState({ notes: [a, b] }))).toEqual(["setup_record_duplicate"]);
    const final = makeNote({ id: "N-002", setup: { setupId: SID, record: "final" } } as never);
    expect(codes(makeState({ notes: [a, final] }))).toEqual([]);
  });
});

function frozen(path: string): SetupPayload["frozen"] {
  return { revision: "a".repeat(64), setupNote: "", handover: { path, content: "" }, historicalReport: "" };
}

function payload(over: Partial<SetupPayload> = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: true,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: null, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: true, gitignore: ["node_modules/"] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "" }],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K1", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [{ key: "K5", title: "Imported", body: "b", labels: [], source: 7 }],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] }],
    ...over,
  };
}

describe("the setup payload", () => {
  it("round-trips through the progress note block, with the engine's fields defaulted", () => {
    const parsed = validateSetupPayload(payload());
    expect(parsed.receipts).toEqual([]);
    expect(parsed.amendments).toEqual([]);
    expect(parsed.preImages).toEqual([]);
    expect(parsed.frozen).toBeNull();
    const note = `Setup in progress.\n\n${renderSetupPayload(parsed)}`;
    expect(note).toContain(SETUP_PAYLOAD_MARKER);
    expect(parseSetupPayload(note)).toEqual(parsed);
  });

  it.each([
    ["no marker", "just text", /no setup payload/],
    ["a future marker", "<!-- storybloq-setup-payload v2 -->\n```json\n{}\n```", /version 2 is not one this CLI reads/],
    ["no fence", `${SETUP_PAYLOAD_MARKER}\n{}`, /json code fence/],
    ["bad JSON", `${SETUP_PAYLOAD_MARKER}\n\`\`\`json\n{ nope\n\`\`\``, /not valid JSON/],
  ])("refuses %s", (_name, note, reason) => {
    expect(() => parseSetupPayload(note)).toThrow(reason);
  });

  it.each([
    ["an unknown version", { version: 2 }, /version 2 is not one this CLI reads/],
    ["an unknown field", { surprise: 1 } as never, /Unrecognized key/],
    ["a bad setup id", { setupId: "SS-1" }, /setupId is not a setup id/],
    ["a key out of range", { issues: [{ key: "K10000", title: "x", body: "", labels: [], source: null }] }, /item key/],
    ["a duplicate key across kinds", { issues: [{ key: "K2", title: "x", body: "", labels: [], source: null }] }, /key K2 is defined twice/],
    ["an undefined blocker", { tickets: [{ key: "K2", title: "a", type: "task", phase: "K1", description: "", blockedBy: ["K9"] }] }, /blocked by K9, which is not a ticket or checkpoint key/],
    ["an issue as a blocker", { tickets: [{ key: "K2", title: "a", type: "task", phase: "K1", description: "", blockedBy: ["K5"] }] }, /blocked by K5/],
    ["a ticket in a non-phase", { tickets: [{ key: "K2", title: "a", type: "task", phase: "K5", description: "", blockedBy: [] }] }, /names phase K5/],
    ["a cycle of blockers", { tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: ["K3"] },
      { key: "K3", title: "Profile", type: "feature", phase: "K1", description: "d", blockedBy: ["K2"] },
    ] }, /cycle/],
    ["a cycle through a gate", { checkpoints: [
      { key: "K4", title: "Accept profile", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K3"], gates: ["K3"] },
    ] }, /cycle: (K3 -> K4 -> K3|K4 -> K3 -> K4)/],
    ["a canonical path escaping the project", { governance: { canonicalFactsPath: "../outside.md", files: [] } }, /leaves the project/],
    ["an absolute governance file", { governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "/etc/x", content: "" }] } }, /leaves the project/],
    ["a workdir escaping the project", { quality: { level: "full", verifyApplies: false, components: [{ id: "c", workdir: "../x", test: null, build: null, verify: null }] } }, /outside the project/],
    ["a pending stage without a reason", { quality: { level: "full", verifyApplies: false, components: [{ id: "c", workdir: ".", test: { command: "pytest", status: "pending" }, build: null, verify: null }] } }, /pending stage with no reason/],
    ["two verify plans", { quality: { level: "full", verifyApplies: true, components: [
      { id: "a", workdir: "a", test: null, build: null, verify: { startCommand: "npm run dev", readinessUrl: "http://localhost:3000", status: "established" } },
      { id: "b", workdir: "b", test: null, build: null, verify: { startCommand: "npm run dev", readinessUrl: "http://localhost:5173", status: "established" } },
    ] } }, /more than one component has a verify plan/],
    ["an absolute frozen handover path", { frozen: frozen("/etc/handover.md") }, /frozen handover path leaves the project: \/etc\/handover.md/],
    ["a frozen handover path escaping the project", { frozen: frozen("../outside/handover.md") }, /frozen handover path leaves the project/],
    ["a component id defined twice with conflicting commands", { quality: { level: "full", verifyApplies: false, components: [
      { id: "c", workdir: ".", test: { command: "npm test", status: "established" }, build: null, verify: null },
      { id: "c", workdir: "api", test: { command: "pytest", status: "established" }, build: null, verify: null },
    ] } }, /component id c is defined twice/],
    ["two governance files that are the same file", { governance: { canonicalFactsPath: "CLAUDE.md", files: [
      { path: "RULES.md", content: "a" }, { path: "a/../RULES.md", content: "b" },
    ] } }, /governance files RULES.md and a\/..\/RULES.md are the same file/],
    ["./RULES.md beside RULES.md", { governance: { canonicalFactsPath: "CLAUDE.md", files: [
      { path: "./RULES.md", content: "a" }, { path: "RULES.md", content: "b" },
    ] } }, /are the same file/],
    ["a decision checkpoint with criteria", { checkpoints: [{ key: "K4", title: "x", kind: "decision", criteria: "c", evidenceRefs: [], description: "", phase: "K1", blockedBy: [], gates: [] }] }, /needs exactly its question/],
    ["coverage naming nothing defined", { coverage: [{ requirement: "R1", text: "t", source: "s", keys: ["K77"] }] }, /names K77/],
    ["coverage with no keys and no deferral", { coverage: [{ requirement: "R1", text: "t", source: "s", keys: [] }] }, /records no deferral/],
  ] as const)("refuses %s", (_name, over, reason) => {
    expect(() => validateSetupPayload(payload(over as Partial<SetupPayload>))).toThrow(reason);
  });
});

describe("a component's test command is one invocation (S2a finding 3)", () => {
  const withTest = (command: string) => payload({ quality: { level: "full", verifyApplies: false, components: [
    { id: "root", workdir: ".", test: { command, status: "established" }, build: null, verify: null },
  ] } } as Partial<SetupPayload>);

  it.each([
    ["npm test; rm -rf build", ";"],
    ["npm ci && npm test", "&&"],
    ["npm test || true", "||"],
    ["npm test | tee out", "|"],
    ["npm test &", "&"],
    ["(npm test)", "("],
    ["npm test )", ")"],
    ["npm test `x`", "`"],
    ["npm test $(x)", "$("],
    ["npm test > out", ">"],
    ["npm test < in", "<"],
    ["npm test\npytest", "a newline"],
  ])("refuses %j, naming %s", (command, token) => {
    expect(() => validateSetupPayload(withTest(command))).toThrow(`uses \`${token}\``.replace("`a newline`", "a newline"));
  });

  it("refuses a cd step and says to put a multi-step test behind one script", () => {
    expect(() => validateSetupPayload(withTest("cd backend"))).toThrow(/uses the shell builtin `cd`.*one script, such as an npm script or a Makefile target/);
  });

  it.each([
    ["npm test # frontend", /uses a comment \(`#`\)/],
    ["npm test #", /uses a comment/],
    ["'cd' ..", /uses the shell builtin `cd`/],
    ["\"cd\" ..", /uses the shell builtin `cd`/],
    ["c\\d ..", /uses the shell builtin `cd`/],
    ["exit 0", /uses the shell builtin `exit`/],
    [". ./env.sh", /uses the shell builtin `\.`/],
    ["eval npm test", /uses the shell builtin `eval`/],
    ["CI=1 npm test", /uses an environment assignment/],
    ["npm test 'unclosed", /uses an unclosed quote/],
    ["npm test \"$(x)\"", /uses `\$\(`/],
  ])("refuses %j as the shell reads it", (command, reason) => {
    expect(() => validateSetupPayload(withTest(command))).toThrow(reason);
  });

  it("accepts one invocation with arguments", () => {
    for (const command of ["npm test -- --run", "python manage.py test", "go test ./...", "make test", "pytest -k 'a or b'", "npm test a#b", "pytest \"x # y\""]) {
      expect(() => validateSetupPayload(withTest(command))).not.toThrow();
    }
  });
});

describe("the chain a valid payload produces runs every component (S2a finding 6)", () => {
  it("two components both run, in order", async () => {
    const { mkdtempSync, mkdirSync, existsSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { computeInitialStages } = await import("../../src/core/verification-activation.js");
    const parsed = validateSetupPayload(payload({ quality: { level: "full", verifyApplies: false, components: [
      { id: "web", workdir: "web app", test: { command: "touch ran-web", status: "established" }, build: null, verify: null },
      { id: "api", workdir: "api", test: { command: "touch ran-api", status: "established" }, build: null, verify: null },
    ] } } as Partial<SetupPayload>));
    const command = computeInitialStages({ level: parsed.quality.level, verifyApplies: parsed.quality.verifyApplies, components: parsed.quality.components }).stages.TEST!.command as string;
    const root = mkdtempSync(join(tmpdir(), "t538-s2-chain-"));
    try {
      mkdirSync(join(root, "web app"));
      mkdirSync(join(root, "api"));
      execFileSync("/bin/bash", ["-c", command], { cwd: root });
      expect(existsSync(join(root, "web app", "ran-web"))).toBe(true);
      expect(existsSync(join(root, "api", "ran-api"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
