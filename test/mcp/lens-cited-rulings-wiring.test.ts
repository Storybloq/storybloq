/**
 * T-494: the delivery wiring, tested through the REGISTERED MCP tool.
 *
 * Why this file exists and why it is not more unit tests of `handlePrepare`.
 * `handlePrepare` takes resolved citations and resolves none itself. Every unit
 * test of the fit, the undelivered set and the verdict hold passed while the one
 * production caller -- `storybloq_review_lenses_prepare` -- passed no citations
 * at all, so real lens reviews received no rulings and the hold could never
 * fire. A green suite proved the mechanism worked on inputs nothing produced.
 * These tests go through `registerAllTools`, so a handler that stops resolving
 * citations fails here no matter how well the harness behaves.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleRulingCreate } from "../../src/cli/commands/ruling.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RULING_TEXT = "Owner ruling: rulings reach agents by citation, never by paste.";
const OTHER_RULING_TEXT = "Owner ruling: the second decision, distinguishable from the first.";

async function newTicket(root: string, title: string): Promise<string> {
  const created = await handleTicketCreate(
    { title, type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  return JSON.parse(created.output).data.id as string;
}

async function newRulingCiting(root: string, text: string, cites: string[]): Promise<void> {
  await handleRulingCreate(
    { text, attribution: "owner-direct", date: "2026-09-06", scopeTags: [], cites, clientTaskId: "wiring-test" },
    "json",
    root,
  );
}

/** A project with one ticket citing one ruling. */
async function fixture(): Promise<{ root: string; ticketId: string; tools: Map<string, RegisteredTool> }> {
  const root = await mkdtemp(join(tmpdir(), "mcp-lens-rulings-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  const ticketId = await newTicket(root, "Cited ticket");
  await newRulingCiting(root, RULING_TEXT, [ticketId]);
  return { root, ticketId, tools: captureTools(root) };
}

/**
 * Writes the minimum session record `resolveGatedSessionDir` will read back,
 * naming `ticketId` as the session's current item.
 */
function writeSessionNaming(root: string, sessionId: string, ticketId: string | null, issueId?: string): void {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: "CODE_REVIEW",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: { workspaceId: "test-ws", lastHeartbeat: now, expiresAt: new Date(Date.now() + 1_800_000).toISOString() },
    ownerTask: { client: "claude", id: "wiring-test", boundAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"], handoverInterval: 3 },
    ...(ticketId === null
      ? {}
      : { ticket: { id: ticketId, displayId: null, title: "Cited ticket", risk: null, realizedRisk: null, claimed: false } }),
    ...(issueId === undefined
      ? {}
      : { currentIssue: { id: issueId, displayId: null, title: "Cited issue", severity: "medium" } }),
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

interface PreparePayload {
  lensPrompts: Array<{ lens: string; prompt: string; omittedCitedRulings?: string[] }>;
  metadata: { citedRulingsUndelivered: Record<string, string[]>; citedRulingsUnavailable?: string; reviewId: string };
}

async function prepare(
  tools: Map<string, RegisteredTool>,
  args: Record<string, unknown>,
): Promise<PreparePayload> {
  const result = await tools.get("storybloq_review_lenses_prepare")!.handler({
    stage: "CODE_REVIEW",
    diff: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
    changedFiles: ["a.ts"],
    ...args,
  });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as PreparePayload;
}

/**
 * A ticketDescription that leaves the widest lens prompt ~200 characters below
 * the cap, so a cited ruling's TEXT cannot fit and is reported undelivered.
 *
 * Measured from two probes rather than guessed: `ticketDescription` is embedded
 * TWICE in a lens prompt and the per-lens preambles differ, so a constant would
 * either overshoot (empty prompts) or leave room.
 */
async function descriptionAtCapacity(tools: Map<string, RegisteredTool>): Promise<string> {
  const widest = (p: PreparePayload) => Math.max(...p.lensPrompts.map((x) => x.prompt.length));
  const small = widest(await prepare(tools, { ticketDescription: "t" }));
  const large = widest(await prepare(tools, { ticketDescription: "t".repeat(1_001) }));
  const slope = (large - small) / 1_000;
  const intercept = small - slope;
  const MAX_PROMPT_SIZE = 200_000;
  return "t".repeat(Math.max(1, Math.floor((MAX_PROMPT_SIZE - 200 - intercept) / slope)));
}

function everyPrompt(payload: PreparePayload): string[] {
  return payload.lensPrompts.map((p) => p.prompt).filter((p) => p.length > 0);
}

describe("T-494 lens delivery is wired at the MCP entry point", () => {
  it("exposes `target` on the registered prepare schema", async () => {
    const { tools } = await fixture();
    const schema = tools.get("storybloq_review_lenses_prepare")!.config.inputSchema as { shape: Record<string, unknown> };
    expect(Object.keys(schema.shape)).toContain("target");
  });

  it("exposes `citedRulingsUndelivered` on the registered SYNTHESIZE schema", async () => {
    // Its own assertion, because `captureTools` hands args straight to the
    // handler: the schema is not enforced here, so a handler that still reads
    // the field passes every behavioural test in this file while the registered
    // tool has no way to receive it. That is the whole defect in miniature.
    const { tools } = await fixture();
    const schema = tools.get("storybloq_review_lenses_synthesize")!.config.inputSchema as { shape: Record<string, unknown> };
    expect(Object.keys(schema.shape)).toContain("citedRulingsUndelivered");
  });

  it("delivers the cited ruling TEXT into EVERY lens prompt for an explicit target", async () => {
    const { tools, ticketId } = await fixture();
    const payload = await prepare(tools, { target: ticketId });
    const prompts = everyPrompt(payload);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("## Cited Rulings");
      expect(prompt).toContain(RULING_TEXT);
    }
  });

  it("delivers NOTHING when no target is named, so the assertion above is not passing on ambient text", async () => {
    const { tools } = await fixture();
    const prompts = everyPrompt(await prepare(tools, {}));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("## Cited Rulings");
      expect(prompt).not.toContain(RULING_TEXT);
    }
  });

  it("takes the target from the SESSION's current ticket when none is named", async () => {
    const { root, tools, ticketId } = await fixture();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeSessionNaming(root, sessionId, ticketId);
    const prompts = everyPrompt(await prepare(tools, { sessionId }));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).toContain(RULING_TEXT);
  });

  it("falls back to the session's current ISSUE when it has no ticket", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-lens-rulings-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const created = await tools.get("storybloq_issue_create")!.handler({
      title: "Cited issue",
      description: "d",
      severity: "medium",
      impact: "none",
      components: [],
      relatedTickets: [],
      location: [],
    });
    expect(created.isError).toBeFalsy();
    const issueId = /\b(i-[0-9a-z]+|ISS-\d+)\b/.exec(created.content[0]!.text)![1]!;
    await newRulingCiting(root, RULING_TEXT, [issueId]);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    writeSessionNaming(root, sessionId, null, issueId);
    const prompts = everyPrompt(await prepare(tools, { sessionId }));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).toContain(RULING_TEXT);
  });

  it("prefers the EXPLICIT target over the session's item", async () => {
    const { root, tools, ticketId } = await fixture();
    const otherTicket = await newTicket(root, "Other ticket");
    await newRulingCiting(root, OTHER_RULING_TEXT, [otherTicket]);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    writeSessionNaming(root, sessionId, ticketId);
    const prompts = everyPrompt(await prepare(tools, { sessionId, target: otherTicket }));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain(OTHER_RULING_TEXT);
      expect(prompt).not.toContain(RULING_TEXT);
    }
  });
});

describe("T-494 the entry point reports what it could not deliver", () => {
  it("reports a NAMED target whose citations could not be resolved", async () => {
    const { tools } = await fixture();
    const payload = await prepare(tools, { target: "T-99999" });
    expect(payload.metadata.citedRulingsUnavailable).toContain("T-99999");
  });

  it("tells the LENSES so, rather than handing them a prompt with no rulings and no reason to doubt it", async () => {
    const { tools } = await fixture();
    const prompts = everyPrompt(await prepare(tools, { target: "T-99999" }));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("## Cited Rulings: NOT AVAILABLE");
      expect(prompt).toContain("do not read the absence of a rulings block as an absence of rulings");
    }
  });

  it("stays SILENT when no target was named, because a review naming no item owes no rulings", async () => {
    const { tools } = await fixture();
    const payload = await prepare(tools, {});
    expect(payload.metadata.citedRulingsUnavailable).toBeUndefined();
    for (const prompt of everyPrompt(payload)) {
      expect(prompt).not.toContain("## Cited Rulings: NOT AVAILABLE");
    }
  });

  it("carries a CAPACITY failure into the metadata synthesize reads", async () => {
    const { tools, ticketId } = await fixture();
    const description = await descriptionAtCapacity(tools);
    const payload = await prepare(tools, { target: ticketId, ticketDescription: description });
    const undelivered = payload.metadata.citedRulingsUndelivered;
    expect(Object.keys(undelivered).length).toBeGreaterThan(0);
    for (const ids of Object.values(undelivered)) expect(ids.length).toBeGreaterThan(0);

    // The handoff, through the REGISTERED synthesize tool, with no sessionId.
    //
    // This is the half that made the metadata assertion above insufficient on
    // its own: without a session there is nothing on disk for prepare to have
    // written, so the echoed map is the only route a delivery failure has, and
    // a synthesize schema that could not accept it let an incomplete manual
    // review reach approve while every prepare-side test still passed.
    const synth = await tools.get("storybloq_review_lenses_synthesize")!.handler({
      stage: "CODE_REVIEW",
      lensResults: payload.lensPrompts.map((p) => ({
        lens: p.lens,
        output: { status: "ok", findings: [], error: null, notes: "" },
      })),
      activeLenses: payload.lensPrompts.map((p) => p.lens),
      skippedLenses: [],
      reviewRound: 1,
      reviewId: payload.metadata.reviewId,
      citedRulingsUndelivered: undelivered,
      diff: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
      changedFiles: ["a.ts"],
    });
    expect(synth.isError).toBeFalsy();
    const verdict = JSON.parse(synth.content[0]!.text) as {
      reviewVerdict: { verdict: string; nextActions?: Array<{ lensId: string }> };
    };
    expect(verdict.reviewVerdict.verdict).not.toBe("approve");
    expect((verdict.reviewVerdict.nextActions ?? []).map((a) => a.lensId).sort())
      .toEqual(Object.keys(undelivered).sort());
  });

  it("has NO hold when the sessionless caller withholds the map, which is what makes the echo required", async () => {
    // Not a defect being pinned. It is the honest statement of what the schema
    // field buys, and of what the doc's "required without a sessionId" costs if
    // ignored: same round, same lens outputs, map withheld, and a review that
    // never saw its rulings carries no retry at all.
    const { tools, ticketId } = await fixture();
    const description = await descriptionAtCapacity(tools);
    const payload = await prepare(tools, { target: ticketId, ticketDescription: description });

    // The SAME round as the test above, with a real omission to lose. Driving
    // this with an uncited, uncapped prepare would prove only that a review
    // with nothing undelivered has nothing to hold on, which is not the claim.
    expect(Object.keys(payload.metadata.citedRulingsUndelivered).length).toBeGreaterThan(0);

    const synth = await tools.get("storybloq_review_lenses_synthesize")!.handler({
      stage: "CODE_REVIEW",
      lensResults: payload.lensPrompts.map((p) => ({
        lens: p.lens,
        output: { status: "ok", findings: [], error: null, notes: "" },
      })),
      activeLenses: payload.lensPrompts.map((p) => p.lens),
      skippedLenses: [],
      reviewRound: 1,
      reviewId: payload.metadata.reviewId,
      // citedRulingsUndelivered deliberately WITHHELD.
      diff: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
      changedFiles: ["a.ts"],
    });
    expect(synth.isError).toBeFalsy();
    const verdict = JSON.parse(synth.content[0]!.text) as {
      reviewVerdict: { nextActions?: Array<{ lensId: string }> };
    };
    expect(verdict.reviewVerdict.nextActions ?? []).toEqual([]);
  });
});
