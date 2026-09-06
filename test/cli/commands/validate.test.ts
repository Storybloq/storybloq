import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleValidate, handleValidateWithSourceRefs } from "../../../src/cli/commands/validate.js";

type Json = Record<string, unknown>;

async function writeArrangementFile(root: string, id: string, overrides: Json): Promise<void> {
  await mkdir(join(root, ".story", "arrangements"), { recursive: true });
  await writeFile(join(root, ".story", "arrangements", `${id}.json`), JSON.stringify({
    id,
    lifecycle: "active",
    bounds: ["T-001"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "pen-session" },
      { role: "worker", client: "claude", identityAnchor: "worker-session" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  }));
}
import { ExitCode } from "../../../src/core/output-formatter.js";
import { writeRulingUnlocked } from "../../../src/core/ruling-loader.js";
import { makeIssue, makeState, makeTicket, makeRuling, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleValidate", () => {
  it("returns OK when validation passes", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleValidate(ctx);
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.output).toContain("passed");
  });

  it("returns VALIDATION_ERROR when validation fails", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "nonexistent" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleValidate(ctx);
    expect(result.exitCode).toBe(ExitCode.VALIDATION_ERROR);
    expect(result.output).toContain("failed");
  });

  it("merges loader warnings into findings", () => {
    const ctx = makeCtx({
      warnings: [
        { file: "tickets/bad.json", message: "parse error", type: "parse_error" },
      ],
    });
    const result = handleValidate(ctx);
    expect(result.output).toContain("parse error");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handleValidate(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it("cosmetic-only warnings do not cause VALIDATION_ERROR", () => {
    const ctx = makeCtx({
      warnings: [
        { file: "handovers/readme.md", message: "no date prefix", type: "naming_convention" },
      ],
    });
    const result = handleValidate(ctx);
    // naming_convention is info level in mergeValidation, valid stays true
    expect(result.exitCode).toBe(ExitCode.OK);
  });

  it("does not validate source provenance on deleted issues", async () => {
    const ctx = makeCtx({
      format: "json",
      state: makeState({
        issues: [makeIssue({
          id: "ISS-001",
          lifecycle: "deleted",
          sourceRefs: [{
            path: "missing.ts",
            startLine: 1,
            revision: "deadbeef",
            contentHash: "a".repeat(64),
          }],
        })],
      }),
    });

    const result = await handleValidateWithSourceRefs(ctx);
    const parsed = JSON.parse(result.output);

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(parsed.data.findings).not.toContainEqual(
      expect.objectContaining({ code: expect.stringMatching(/^source_ref_/) }),
    );
  });

  describe("T-476: ruling side-store wiring (acceptance 3)", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "validate-rulings-"));
      tempDirs.push(root);
      return root;
    }

    it("flags a ticket citing a superseded ruling", async () => {
      const root = await tempRoot();
      await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root, { createOnly: true });
      await writeRulingUnlocked(
        makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
        root,
        { createOnly: true },
      );
      const ctx = makeCtx({
        root,
        format: "json",
        state: makeState({ tickets: [makeTicket({ id: "T-001", citesRulings: ["r-0000000000000001"] })] }),
      });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings).toContainEqual(
        expect.objectContaining({ code: "superseded_ruling_citation", entity: "T-001" }),
      );
    });

    it("surfaces a broken ruling file as a ruling_loader_warning finding", async () => {
      const root = await tempRoot();
      await mkdir(join(root, ".story", "rulings"), { recursive: true });
      await writeFile(join(root, ".story", "rulings", "r-broken00000001.json"), "{not json", "utf8");
      const ctx = makeCtx({ root, format: "json" });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings).toContainEqual(
        expect.objectContaining({ code: "ruling_loader_warning" }),
      );
    });

    it("does not affect validation when .story/rulings/ does not exist (ordinary pre-T-476 project)", async () => {
      const root = await tempRoot();
      const ctx = makeCtx({
        root,
        format: "json",
        state: makeState({
          tickets: [makeTicket({ id: "T-001", phase: "p1" })],
          roadmap: makeRoadmap([makePhase({ id: "p1" })]),
        }),
      });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings.filter((f: { code: string }) => f.code.includes("ruling"))).toEqual([]);
      expect(result.exitCode).toBe(ExitCode.OK);
    });
  });

  describe("T-478: arrangement gate-risk diagnostic (ISS-1050 interim)", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "validate-arrangements-"));
      tempDirs.push(root);
      return root;
    }

    it("surfaces an arrangement_gate_risk warning for a plan-ack-without-pre-commit-ack arrangement", async () => {
      const root = await tempRoot();
      await writeArrangementFile(root, "a-0123456789abcdef", {
        gates: [{ name: "plan-ack", ackRole: "pen" }],
      });
      const ctx = makeCtx({ root, format: "json" });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings).toContainEqual(
        expect.objectContaining({ code: "arrangement_gate_risk", message: expect.stringContaining("a-0123456789abcdef") }),
      );
      // A warning-level finding must not flip validation to failed.
      expect(result.exitCode).toBe(ExitCode.OK);
    });

    it("does not warn for an arrangement with both plan-ack and pre-commit-ack", async () => {
      const root = await tempRoot();
      await writeArrangementFile(root, "a-0123456789abcdef", {
        gates: [{ name: "plan-ack", ackRole: "pen" }, { name: "pre-commit-ack", ackRole: "pen" }],
      });
      const ctx = makeCtx({ root, format: "json" });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings.filter((f: { code: string }) => f.code === "arrangement_gate_risk")).toEqual([]);
    });

    it("codex round-1 finding: surfaces a broken arrangement file as an arrangement_loader_warning finding, honoring conflicts.ts's 'Run storybloq validate for details' promise", async () => {
      const root = await tempRoot();
      await mkdir(join(root, ".story", "arrangements"), { recursive: true });
      await writeFile(join(root, ".story", "arrangements", "a-broken00000001.json"), "{not json");
      const ctx = makeCtx({ root, format: "json" });
      const result = handleValidate(ctx);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.findings).toContainEqual(
        expect.objectContaining({ code: "arrangement_loader_warning" }),
      );
      // A loader warning is advisory, not a validation failure.
      expect(result.exitCode).toBe(ExitCode.OK);
    });
  });
});

describe("T-494: the validate command supplies the citing-entity completeness half", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reports reachability UNKNOWN when the ticket/issue load dropped a corrupt entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "validate-reach-"));
    tmpDirs.push(root);
    await mkdir(join(root, ".story"), { recursive: true });
    await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root);

    // The unit tests can only prove `validateRulings` HONOURS the flag. This
    // one proves the command actually computes it from the load warnings: a
    // hardcoded `true` at the call site would pass every unit test and still
    // claim "no ticket or issue cites this" over a ledger that dropped one.
    const ctx = makeCtx({
      root,
      state: makeState({ tickets: [makeTicket({ id: "T-1" })] }),
      warnings: [{ file: ".story/tickets/T-9.json", message: "unparseable", type: "parse_error" }],
    });
    const result = handleValidate(ctx);

    expect(result.output).toContain("ruling_reachability_unknown");
    expect(result.output).not.toContain("unreachable_ruling");
  });

  it("computes reachability when the load reported no integrity warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "validate-reach-ok-"));
    tmpDirs.push(root);
    await mkdir(join(root, ".story"), { recursive: true });
    await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root);

    const ctx = makeCtx({
      root,
      state: makeState({ tickets: [makeTicket({ id: "T-1" })] }),
      warnings: [{ file: ".story/tickets/T-9.json", message: "odd name", type: "naming_convention" }],
    });
    const result = handleValidate(ctx);

    // A cosmetic warning drops no record, so it must not suppress the check.
    expect(result.output).toContain("unreachable_ruling");
    expect(result.output).not.toContain("ruling_reachability_unknown");
  });

  it("still computes reachability when the dropped entry was a NOTE, which cannot cite anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "validate-reach-note-"));
    tmpDirs.push(root);
    await mkdir(join(root, ".story"), { recursive: true });
    await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root);

    // The question is "does any TICKET OR ISSUE cite this ruling", and nothing
    // else has a citesRulings field. Treating every integrity warning as an
    // incomplete citing-entity scan meant one corrupt note suppressed every
    // reachability finding in the project and reported a scan that was, for
    // this question, complete.
    const ctx = makeCtx({
      root,
      state: makeState({ tickets: [makeTicket({ id: "T-1" })] }),
      warnings: [{ file: ".story/notes/N-9.json", message: "unparseable", type: "parse_error" }],
    });
    const result = handleValidate(ctx);

    expect(result.output).toContain("unreachable_ruling");
    expect(result.output).not.toContain("ruling_reachability_unknown");
  });

  it("reports UNKNOWN for an ISSUE drop as well as a ticket drop", async () => {
    const root = await mkdtemp(join(tmpdir(), "validate-reach-issue-"));
    tmpDirs.push(root);
    await mkdir(join(root, ".story"), { recursive: true });
    await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root);

    // Both entity kinds can cite, so scoping the check to tickets alone would
    // be the same bug in the other direction.
    const ctx = makeCtx({
      root,
      state: makeState({ tickets: [makeTicket({ id: "T-1" })] }),
      warnings: [{ file: ".story/issues/i-abc.json", message: "unparseable", type: "parse_error" }],
    });
    const result = handleValidate(ctx);

    expect(result.output).toContain("ruling_reachability_unknown");
    expect(result.output).not.toContain("unreachable_ruling");
  });
});
