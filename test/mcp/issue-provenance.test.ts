import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "./tool-schema-helpers.js";
import { initProject } from "../../src/core/init.js";

interface RegisteredTool {
  config: { inputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
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

describe("issue provenance through registered MCP tools", () => {
  it("accepts structured refs and makes duplicate retries idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-issue-provenance-"));
    tempDirs.push(root);
    await initProject(root, { name: "issues" });
    await writeFile(join(root, "source.ts"), "one\ntwo\n", "utf8");

    const tool = captureTools(root).get("storybloq_issue_create");
    if (!tool) throw new Error("storybloq_issue_create was not registered");
    const schema = toolSchema(tool.config.inputSchema);
    const args = schema.parse({
      title: "MCP finding",
      severity: "high",
      impact: "broken",
      sourceRefs: [{ path: "source.ts", startLine: 2, reviewId: "review-1" }],
      dedupeKey: "review:source.ts:2:logic",
      createdBy: "external-reviewer",
    });

    const first = await tool.handler(args);
    const second = await tool.handler(args);
    const files = (await readdir(join(root, ".story", "issues"))).filter((file) => file.endsWith(".json"));
    const issue = JSON.parse(await readFile(join(root, ".story", "issues", files[0]!), "utf8"));

    expect(first.content[0]!.text).toContain("Created issue");
    expect(second.content[0]!.text).toContain("already exists");
    expect(files).toHaveLength(1);
    expect(issue).toMatchObject({
      status: "open",
      resolution: null,
      createdBy: "external-reviewer",
      dedupeKey: "review:source.ts:2:logic",
      sourceRefs: [expect.objectContaining({
        path: "source.ts",
        reviewId: "review-1",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    });
  });

  it("preserves lens provenance, review-scopes retries, and files later recurrences", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-lens-provenance-"));
    tempDirs.push(root);
    await initProject(root, { name: "issues" });
    await writeFile(join(root, "source.ts"), "const one = 1;\nconst value = risky();\n", "utf8");

    const tool = captureTools(root).get("storybloq_review_lenses_synthesize");
    if (!tool) throw new Error("storybloq_review_lenses_synthesize was not registered");
    const schema = toolSchema(tool.config.inputSchema);
    const empty = { status: "ok", findings: [], error: null, notes: null };
    const finding = {
      id: "eh-1",
      severity: "major",
      category: "unchecked-error",
      file: "source.ts",
      line: 2,
      snippet: { quote: "const value = risky();\n", startLine: 2 },
      description: "A pre-existing risky call is unchecked.",
      suggestion: "Handle the failure.",
      confidence: 0.95,
    };
    const args = schema.parse({
      stage: "CODE_REVIEW",
      reviewId: "lens-provenance-1",
      reviewRound: 1,
      activeLenses: ["security", "error-handling", "clean-code", "concurrency"],
      skippedLenses: ["performance", "api-design", "test-quality", "accessibility", "data-safety"],
      lensResults: [
        { lens: "security", output: empty },
        { lens: "error-handling", output: { ...empty, findings: [finding] } },
        { lens: "clean-code", output: empty },
        { lens: "concurrency", output: empty },
      ],
      diff: [
        "diff --git a/changed.ts b/changed.ts",
        "--- a/changed.ts",
        "+++ b/changed.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      changedFiles: ["changed.ts"],
    });

    const first = JSON.parse((await tool.handler(args)).content[0]!.text);
    const second = JSON.parse((await tool.handler(args)).content[0]!.text);
    const files = (await readdir(join(root, ".story", "issues"))).filter((file) => file.endsWith(".json"));
    const issue = JSON.parse(await readFile(join(root, ".story", "issues", files[0]!), "utf8"));

    expect(first.filedIssues).toHaveLength(1);
    expect(second.filedIssues[0].issueId).toBe(first.filedIssues[0].issueId);
    expect(files).toHaveLength(1);
    expect(issue).toMatchObject({
      createdBy: "review-lenses:error-handling",
      dedupeKey: expect.stringMatching(/^review-lenses:[a-f0-9]{64}$/),
      sourceRefs: [expect.objectContaining({
        path: "source.ts",
        startLine: 2,
        reviewId: "lens-provenance-1",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    });
    expect(JSON.stringify(issue)).not.toContain("const value = risky()");

    await writeFile(
      join(root, ".story", "issues", files[0]!),
      JSON.stringify({
        ...issue,
        status: "resolved",
        resolution: "Fixed after the first review.",
        resolvedDate: "2026-07-11",
      }),
      "utf8",
    );
    const recurrenceArgs = schema.parse({ ...args, reviewId: "lens-provenance-2" });
    const recurrence = JSON.parse((await tool.handler(recurrenceArgs)).content[0]!.text);
    const recurrenceFiles = (await readdir(join(root, ".story", "issues")))
      .filter((file) => file.endsWith(".json"));
    const recurrenceIssues = await Promise.all(recurrenceFiles.map(async (file) =>
      JSON.parse(await readFile(join(root, ".story", "issues", file), "utf8")),
    ));

    expect(recurrence.filedIssues).toHaveLength(1);
    expect(recurrence.filedIssues[0].issueId).not.toBe(first.filedIssues[0].issueId);
    expect(recurrenceFiles).toHaveLength(2);
    expect(recurrenceIssues.map((record) => record.status).sort()).toEqual(["open", "resolved"]);
    expect(new Set(recurrenceIssues.map((record) => record.dedupeKey)).size).toBe(2);
  });

  it("files a verified finding without sourceRefs when provenance enrichment is unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-lens-provenance-"));
    tempDirs.push(root);
    await initProject(root, { name: "issues" });
    await writeFile(join(root, "source.ts"), "const value = risky();\n", "utf8");
    await symlink("source.ts", join(root, "linked.ts"));

    const tool = captureTools(root).get("storybloq_review_lenses_synthesize");
    if (!tool) throw new Error("storybloq_review_lenses_synthesize was not registered");
    const schema = toolSchema(tool.config.inputSchema);
    const empty = { status: "ok", findings: [], error: null, notes: null };
    const finding = {
      id: "eh-symlink",
      severity: "major",
      category: "unchecked-error",
      file: "linked.ts",
      line: 1,
      snippet: { quote: "const value = risky();", startLine: 1 },
      description: "A pre-existing risky call is unchecked.",
      suggestion: "Handle the failure.",
      confidence: 0.95,
    };
    const args = schema.parse({
      stage: "CODE_REVIEW",
      reviewId: "lens-provenance-symlink",
      reviewRound: 1,
      activeLenses: ["security", "error-handling", "clean-code", "concurrency"],
      skippedLenses: ["performance", "api-design", "test-quality", "accessibility", "data-safety"],
      lensResults: [
        { lens: "security", output: empty },
        { lens: "error-handling", output: { ...empty, findings: [finding] } },
        { lens: "clean-code", output: empty },
        { lens: "concurrency", output: empty },
      ],
      diff: "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new",
      changedFiles: ["changed.ts"],
    });

    const result = JSON.parse((await tool.handler(args)).content[0]!.text);
    const files = (await readdir(join(root, ".story", "issues"))).filter((file) => file.endsWith(".json"));
    const issue = JSON.parse(await readFile(join(root, ".story", "issues", files[0]!), "utf8"));

    expect(result.preExistingFindings).toHaveLength(1);
    expect(result.filedIssues).toHaveLength(1);
    expect(result.filingWarnings).toContainEqual(expect.objectContaining({
      code: "source_provenance_omitted",
    }));
    expect(files).toHaveLength(1);
    expect(issue.location).toEqual(["linked.ts:1"]);
    expect(issue.sourceRefs).toBeUndefined();
  });

  it("rejects unsafe source paths at the real MCP schema boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-issue-provenance-"));
    tempDirs.push(root);
    await initProject(root, { name: "issues" });
    const tool = captureTools(root).get("storybloq_issue_create");
    if (!tool) throw new Error("storybloq_issue_create was not registered");
    const schema = toolSchema(tool.config.inputSchema);

    expect(() => schema.parse({
      title: "Unsafe",
      severity: "high",
      impact: "broken",
      sourceRefs: [{ path: "../outside.ts", startLine: 1 }],
    })).toThrow();
  });
});
