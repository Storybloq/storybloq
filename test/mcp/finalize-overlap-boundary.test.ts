/**
 * ISS-988: report.overrideOverlap was consumed by FINALIZE (finalize.ts, the
 * "Pre-existing untracked files are staged" refusal) and declared on
 * GuideReportInput, but not in the MCP report schema, a bare z.object with no
 * .passthrough(). The SDK stripped it, so the exit the refusal advertises never
 * reached the stage from the only production entry point. Every call here goes
 * through the registered tool (schema parse, then handler), never the stage.
 *
 * B4-B6 also record ISS-063's documented mechanisms as they behave today.
 *
 * ISS-1363: an accepted override is remembered as "staged_override", so a
 * re-sent files_staged (B4) and a legacy precommit_passed report (B6) keep it,
 * and commit_done still accepts it (B8). B9-B12 pin what must stay refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "./tool-schema-helpers.js";
import { initProject } from "../../src/core/init.js";
import { createSession, sessionDir, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId } from "../../src/autonomous/session-types.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { git } from "../helpers/git-fixture.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

const REFUSAL = "Pre-existing untracked files are staged";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) =>
      tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

function guideOf(root: string): RegisteredTool {
  const guide = captureTools(root).get("storybloq_autonomous_guide");
  if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
  return guide;
}

function reportShape(root: string): Record<string, z.ZodTypeAny> {
  const schema = toolSchema(guideOf(root).config.inputSchema) as z.ZodObject<Record<string, z.ZodTypeAny>>;
  return (schema.shape.report as z.ZodOptional<z.ZodObject<Record<string, z.ZodTypeAny>>>).unwrap().shape;
}

interface Fixture {
  readonly root: string;
  readonly dir: string;
  readonly sessionId: string;
  /** The real ledger path of the session's item, as git reports it. */
  readonly ledgerPath: string;
  /** The path FINALIZE builds for that item (`.story/<kind>/<id>.json`). */
  readonly builtPath: string;
}

/**
 * A FINALIZE session with one ledger item, a work change and, unless `stray` is
 * false, a pre-existing untracked `stray.txt` that is staged and in the baseline.
 * `ownInBaseline` also lists the item's own ledger file in the baseline.
 * ISS-1363: `strayStaged: false` writes stray.txt and lists it in the baseline
 * but leaves it unstaged; `itemStaged: false` leaves the item's own ledger file
 * unstaged; `checkpoint` is the finalizeCheckpoint the session starts at.
 */
async function fixture(opts: {
  kind?: "issue" | "ticket";
  stray?: boolean;
  strayStaged?: boolean;
  itemStaged?: boolean;
  ownInBaseline?: boolean;
  checkpoint?: FullSessionState["finalizeCheckpoint"];
} = {}): Promise<Fixture> {
  const kind = opts.kind ?? "issue";
  const stray = opts.stray ?? true;
  const strayStaged = stray && (opts.strayStaged ?? true);
  const itemStaged = opts.itemStaged ?? true;
  const root = mkdtempSync(join(tmpdir(), "iss988-mcp-"));
  roots.push(root);
  await initProject(root, { name: "iss988" });
  git(root, ["init", "-q", "."]);
  git(root, ["config", "user.email", "e2e@example.com"]);
  git(root, ["config", "user.name", "E2E"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
  const initHead = git(root, ["rev-parse", "HEAD"]);

  const created = kind === "issue"
    ? await handleIssueCreate(
      { title: "ISS-988 fixture", severity: "medium", impact: "fixture", components: ["autonomous"], relatedTickets: [], location: [] },
      "json",
      root,
    )
    : await handleTicketCreate(
      { title: "ISS-988 fixture", type: "task", phase: null, description: "fixture", blockedBy: [], parentTicket: null },
      "json",
      root,
    );
  const id = (JSON.parse(created.output ?? "{}") as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error(`${kind} fixture creation failed`);
  const ledger = git(root, ["status", "--porcelain", "-uall", ".story/"]).split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path.startsWith(kind === "issue" ? ".story/issues/" : ".story/tickets/"));
  if (ledger.length !== 1) throw new Error(`expected one new ${kind} ledger file, saw ${JSON.stringify(ledger)}`);
  const ledgerPath = ledger[0]!;
  const builtPath = `.story/${kind === "issue" ? "issues" : "tickets"}/${id}.json`;

  writeFileSync(join(root, "work.txt"), "change\n");
  const untracked: string[] = [];
  if (stray) {
    writeFileSync(join(root, "stray.txt"), "left over\n");
    untracked.push("stray.txt");
  }
  if (opts.ownInBaseline) untracked.push(ledgerPath);
  git(root, ["add", "work.txt", ...(itemStaged ? [ledgerPath] : []), ...(strayStaged ? ["stray.txt"] : [])]);

  const base = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = sessionDir(root, base.sessionId);
  mkdirSync(dir, { recursive: true });
  const state: FullSessionState = {
    ...base,
    state: "FINALIZE",
    finalizeCheckpoint: opts.checkpoint ?? null,
    ...(kind === "issue"
      ? { currentIssue: { id, displayId: id, title: "ISS-988 fixture", severity: "medium" }, ticket: undefined }
      : { ticket: { id, displayId: id, title: "ISS-988 fixture", claimed: false } as FullSessionState["ticket"], currentIssue: null }),
    claimEpoch: null,
    git: {
      ...base.git,
      branch: "main",
      mergeBase: initHead,
      expectedHead: initHead,
      initHead,
      itemBaseHead: initHead,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: untracked },
    },
  } as FullSessionState;
  writeSessionSync(dir, state);
  return { root, dir, sessionId: base.sessionId, ledgerPath, builtPath };
}

interface CallRecord {
  readonly isError: boolean;
  readonly instruction: string;
  readonly checkpoint: string | null;
}

async function report(fx: Fixture, body: Record<string, unknown>): Promise<CallRecord> {
  const guide = guideOf(fx.root);
  const args = toolSchema(guide.config.inputSchema).parse({ sessionId: fx.sessionId, action: "report", report: body });
  const result = await guide.handler(args as Record<string, unknown>);
  const state = JSON.parse(readFileSync(join(fx.dir, "state.json"), "utf-8")) as { finalizeCheckpoint?: string | null };
  return {
    isError: result.isError === true,
    instruction: result.content.map((part) => part.text).join("\n"),
    checkpoint: state.finalizeCheckpoint ?? null,
  };
}

describe("ISS-988: overrideOverlap crosses the MCP boundary", () => {
  it("B1: the registered storybloq_autonomous_guide report schema declares overrideOverlap", () => {
    const root = mkdtempSync(join(tmpdir(), "iss988-schema-"));
    roots.push(root);
    expect(reportShape(root).overrideOverlap).toBeDefined();
  });

  it("B2: a real files_staged report with overrideOverlap: true passes the refusal and reaches the commit instruction", async () => {
    const fx = await fixture();
    const call = await report(fx, { completedAction: "files_staged", overrideOverlap: true });
    expect(call.isError).toBe(false);
    expect(call.instruction).not.toContain(REFUSAL);
    expect(call.instruction).toContain("Now commit");
    // ISS-1363: the accepted override is remembered, not folded into precommit_passed.
    expect(call.checkpoint).toBe("staged_override");
  });

  it.each([
    ["omitted", {}],
    ["false", { overrideOverlap: false }],
  ])("B3: with the flag %s the pre-existing file is refused and the checkpoint stays null", async (_label, flag) => {
    const fx = await fixture();
    const call = await report(fx, { completedAction: "files_staged", ...flag });
    expect(call.instruction).toContain(`${REFUSAL}: stray.txt`);
    expect(call.checkpoint).toBeNull();
  });

  it("B4: a re-sent files_staged after an accepted override returns the commit instruction and keeps the override (ISS-1363 F2)", async () => {
    const fx = await fixture();
    const record: CallRecord[] = [];
    record.push(await report(fx, { completedAction: "files_staged", overrideOverlap: true }));
    record.push(await report(fx, { completedAction: "files_staged", overrideOverlap: true }));
    // The whole record goes into the failure message, so a base failure keeps both calls.
    const seen = JSON.stringify(record, null, 2);
    expect(record[0]!.instruction, seen).not.toContain(REFUSAL);
    expect(record[0]!.instruction, seen).toContain("Now commit");
    expect(record[0]!.checkpoint, seen).toBe("staged_override");
    expect(record[1]!.instruction, seen).not.toContain(REFUSAL);
    expect(record[1]!.instruction, seen).not.toContain("Unexpected action");
    expect(record[1]!.instruction, seen).toContain("Now commit");
    expect(record[1]!.checkpoint, seen).toBe("staged_override");
  });

  it.each([["issue"], ["ticket"]] as const)(
    "B5 (%s): the current item's own pre-existing ledger file is not refused (ISS-063 mechanism 2)",
    async (kind) => {
      const fx = await fixture({ kind, stray: false, ownInBaseline: true });
      expect(fx.builtPath, "path guard: FINALIZE's built path must be the real ledger path").toBe(fx.ledgerPath);
      const call = await report(fx, { completedAction: "files_staged" });
      const seen = JSON.stringify({ ledgerPath: fx.ledgerPath, builtPath: fx.builtPath, call }, null, 2);
      expect(call.instruction, seen).not.toContain(REFUSAL);
      expect(call.instruction, seen).toContain("Now commit");
      expect(call.checkpoint, seen).toBe("precommit_passed");
    },
  );

  it("B6: a legacy precommit_passed report after an accepted override keeps the override (ISS-1363 F1)", async () => {
    const fx = await fixture();
    const staged = await report(fx, { completedAction: "files_staged", overrideOverlap: true });
    expect(staged.checkpoint).toBe("staged_override");
    const legacy = await report(fx, { completedAction: "precommit_passed" });
    const seen = JSON.stringify({ staged, legacy }, null, 2);
    expect(legacy.instruction, seen).not.toContain("Pre-commit hooks staged pre-existing untracked files");
    expect(legacy.instruction, seen).toContain("Pre-commit passed. Now commit.");
    expect(legacy.checkpoint, seen).toBe("staged_override");
  });

  it("B7: the schema parses overrideOverlap as an optional boolean", () => {
    const root = mkdtempSync(join(tmpdir(), "iss988-parse-"));
    roots.push(root);
    const schema = toolSchema(guideOf(root).config.inputSchema);
    const parsed = (value?: unknown) => {
      const body: Record<string, unknown> = { completedAction: "files_staged" };
      if (value !== undefined) body.overrideOverlap = value;
      return (schema.parse({ sessionId: "00000000-0000-4000-8000-000000000000", action: "report", report: body }) as { report: Record<string, unknown> }).report;
    };
    expect(parsed(true).overrideOverlap).toBe(true);
    expect(parsed(false).overrideOverlap).toBe(false);
    expect("overrideOverlap" in parsed()).toBe(false);
    expect(() => parsed("yes")).toThrow();
  });

  it("B8: commit_done after an accepted override is accepted and reaches committed (ISS-1363)", async () => {
    const fx = await fixture();
    const staged = await report(fx, { completedAction: "files_staged", overrideOverlap: true });
    expect(staged.checkpoint).toBe("staged_override");
    git(fx.root, ["commit", "-qm", "work"]);
    const commitHash = git(fx.root, ["rev-parse", "HEAD"]);
    const commit = await report(fx, { completedAction: "commit_done", commitHash });
    const seen = JSON.stringify({ staged, commit }, null, 2);
    expect(commit.instruction, seen).not.toContain("You must pass pre-commit checks first");
    expect(commit.checkpoint, seen).toBe("committed");
  });

  it("B9: without an accepted override, a legacy precommit_passed with a pre-existing file staged still refuses and resets", async () => {
    const fx = await fixture({ checkpoint: "precommit_passed" });
    const call = await report(fx, { completedAction: "precommit_passed" });
    expect(call.instruction, JSON.stringify(call, null, 2)).toContain("Pre-commit hooks staged pre-existing untracked files: stray.txt");
    expect(call.checkpoint).toBeNull();
  });

  it("B10a: a re-sent files_staged at precommit_passed with a clean staged set returns the commit instruction", async () => {
    const fx = await fixture({ checkpoint: "precommit_passed", stray: false });
    const call = await report(fx, { completedAction: "files_staged" });
    const seen = JSON.stringify(call, null, 2);
    expect(call.instruction, seen).not.toContain("Unexpected action");
    expect(call.instruction, seen).toContain("Now commit");
    expect(call.checkpoint, seen).toBe("precommit_passed");
  });

  it("B10b: a re-sent files_staged at precommit_passed with a pre-existing file staged and no override is refused", async () => {
    const fx = await fixture({ checkpoint: "precommit_passed" });
    const call = await report(fx, { completedAction: "files_staged" });
    const seen = JSON.stringify(call, null, 2);
    expect(call.instruction, seen).toContain(`${REFUSAL}: stray.txt`);
    expect(call.checkpoint, seen).toBe("precommit_passed");
  });

  it.each([["issue", "Issue"], ["ticket", "Ticket"]] as const)(
    "B11 (%s): a re-sent files_staged at staged_override still requires the item's own file to be staged",
    async (kind, label) => {
      const fx = await fixture({ kind, checkpoint: "staged_override", itemStaged: false });
      const call = await report(fx, { completedAction: "files_staged" });
      const seen = JSON.stringify({ builtPath: fx.builtPath, call }, null, 2);
      expect(call.instruction, seen).toContain(`${label} file ${fx.builtPath} is not staged`);
      expect(call.checkpoint, seen).toBe("staged_override");
    },
  );

  it("B12: overrideOverlap with nothing to override is not remembered, so a file staged later is still refused", async () => {
    const fx = await fixture({ strayStaged: false });
    const first = await report(fx, { completedAction: "files_staged", overrideOverlap: true });
    expect(first.instruction, JSON.stringify(first, null, 2)).toContain("Now commit");
    expect(first.checkpoint).toBe("precommit_passed");
    git(fx.root, ["add", "stray.txt"]);
    const second = await report(fx, { completedAction: "files_staged" });
    const seen = JSON.stringify({ first, second }, null, 2);
    expect(second.instruction, seen).toContain(`${REFUSAL}: stray.txt`);
    expect(second.checkpoint, seen).toBe("precommit_passed");
  });
});
