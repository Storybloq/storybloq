/**
 * ISS-982 (R3-F1/R4-F3): the MCP report schema in tools.ts is a bare z.object
 * with no .passthrough(), so an undeclared field is stripped before
 * handleAutonomousGuide ever sees it -- overrideOverlap was exactly this
 * dead-from-the-only-real-entry-point shape, and overrideAttribution built
 * the same way would have inherited it silently.
 *
 * Two observables, both genuinely RED-at-parent (parent has no attribution
 * concept at all, so "mismatch is accepted" would pass at parent for an
 * unrelated reason and would not prove the field crossed the boundary):
 * (a) the REGISTERED tool's inputSchema literally contains overrideAttribution.
 * (b) after a REAL MCP call, the resulting commit event carries
 *     attributionOverrideRequested: true.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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
import type { FullSessionState } from "../../src/autonomous/session-types.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) =>
      tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("ISS-982: overrideAttribution crosses the MCP boundary", () => {
  it("(a) the registered storybloq_autonomous_guide tool's inputSchema declares overrideAttribution", () => {
    const root = mkdtempSync(join(tmpdir(), "iss982-mcp-schema-"));
    roots.push(root);
    const tools = captureTools(root);
    const guide = tools.get("storybloq_autonomous_guide");
    if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
    const schema = toolSchema(guide.config.inputSchema) as z.ZodObject<Record<string, z.ZodTypeAny>>;
    const reportSchema = schema.shape.report as z.ZodOptional<z.ZodObject<Record<string, z.ZodTypeAny>>>;
    expect(reportSchema.unwrap().shape.overrideAttribution).toBeDefined();
  });

  it("(b) a real MCP report with overrideAttribution: true records attributionOverrideRequested in the commit event", async () => {
    const root = mkdtempSync(join(tmpdir(), "iss982-mcp-e2e-"));
    roots.push(root);

    await initProject(root, { name: "iss982-e2e" });
    git(root, ["init", "-q", "."]);
    git(root, ["config", "user.email", "e2e@example.com"]);
    git(root, ["config", "user.name", "E2E"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "initial"]);
    const initHead = git(root, ["rev-parse", "HEAD"]);

    const issueResult = await handleIssueCreate(
      { title: "ISS-982 e2e fixture", severity: "medium", impact: "fixture", components: ["autonomous"], relatedTickets: [], location: [] },
      "json",
      root,
    );
    const issueId = (JSON.parse(issueResult.output ?? "{}") as { data?: { id?: string } }).data?.id;
    if (!issueId) throw new Error("issue fixture creation failed");

    // A genuine work commit -- committer mismatches nothing here on purpose;
    // the override should apply regardless of match/mismatch.
    writeFileSync(join(root, "work.txt"), "change\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "work commit"]);
    const workHead = git(root, ["rev-parse", "HEAD"]);

    const workspaceId = deriveWorkspaceId(root);
    const base = createSession(root, "coding", workspaceId);
    const dir = sessionDir(root, base.sessionId);
    mkdirSync(dir, { recursive: true });
    const finalizeState: FullSessionState = {
      ...base,
      state: "FINALIZE",
      finalizeCheckpoint: "precommit_passed",
      currentIssue: { id: issueId, displayId: issueId, title: "ISS-982 e2e fixture", severity: "medium" },
      ticket: undefined,
      claimEpoch: null,
      git: {
        ...base.git,
        branch: "main",
        mergeBase: initHead,
        expectedHead: initHead,
        initHead,
        itemBaseHead: initHead,
      },
    };
    writeSessionSync(dir, finalizeState);

    const tools = captureTools(root);
    const guide = tools.get("storybloq_autonomous_guide");
    if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
    const schema = toolSchema(guide.config.inputSchema);
    const args = schema.parse({
      sessionId: finalizeState.sessionId,
      action: "report",
      report: { completedAction: "commit_done", commitHash: workHead, overrideAttribution: true },
    });

    const result = await guide.handler(args as Record<string, unknown>);
    expect(result.isError).toBeFalsy();

    const events = readFileSync(join(dir, "events.log"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
    const commitEvent = events.find((e) => e.type === "commit");
    expect(commitEvent?.data.attributionOverrideRequested).toBe(true);
    expect(commitEvent?.data.commitHash).toBe(workHead);
  });
});
