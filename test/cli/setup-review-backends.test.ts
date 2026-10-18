/**
 * T-536: the two reviewers the CLI starts itself. The flags are pinned against
 * help text captured from the real binaries (test/fixtures/setup-review/), so
 * a flag that a CLI renames or drops shows up here rather than as a failed
 * review in a user's setup.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeArgs, codexArgs, parseReviewerOutput, reviewerEnv, SETUP_REVIEW_SCHEMA } from "../../src/core/setup-review-backends.js";
import { shouldSkipHousekeeping } from "../../src/cli/housekeeping.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "setup-review");
const claudeHelp = readFileSync(join(FIXTURES, "claude-help-2.1.302.txt"), "utf-8");
const codexHelp = readFileSync(join(FIXTURES, "codex-exec-help-0.163.0.txt"), "utf-8");

describe("setup reviewer backends (T-536)", () => {
  it("runs codex read-only, ephemeral, with a schema file and an output file, the prompt on stdin", () => {
    const args = codexArgs("/s/schema.json", "/s/out.json");
    expect(args).toEqual(["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", "/s/schema.json", "-o", "/s/out.json", "-"]);
    for (const flag of args.filter((a) => a.startsWith("-") && a !== "-")) expect(codexHelp).toContain(flag);
  });

  it("runs claude in print mode with JSON output, the schema, no tools, no MCP servers and no saved session", () => {
    const args = claudeArgs(JSON.stringify(SETUP_REVIEW_SCHEMA));
    expect(args).toEqual(["-p", "--output-format", "json", "--json-schema", JSON.stringify(SETUP_REVIEW_SCHEMA), "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none"]);
    for (const flag of args.filter((a) => a.startsWith("--"))) expect(claudeHelp).toContain(flag);
    expect(args).not.toContain("--bare");
  });

  it("removes the parent Claude Code session from the claude reviewer's environment only", () => {
    const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "x", HOME: "/h" };
    expect(reviewerEnv("claude", env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(reviewerEnv("codex", env)).toEqual(env);
  });

  it("uses a strict-mode schema: every property required, plan verdicts only", () => {
    const s = SETUP_REVIEW_SCHEMA as { required: string[]; properties: Record<string, { enum?: string[]; items?: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } }>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    expect(s.properties.verdict!.enum).toEqual(["approve", "revise", "reject"]);
    const item = s.properties.findings!.items!;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(Object.keys(item.properties));
  });

  it("parses each backend's raw output and refuses anything outside the schema", () => {
    const review = { verdict: "revise", findings: [{ severity: "major", requirement: "R3", description: "missing" }] };
    expect(parseReviewerOutput("codex", Buffer.from(JSON.stringify(review)))).toEqual(review);
    expect(parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: false, structured_output: review, session_id: "s" })))).toEqual({ ...review, sessionId: "s" });
    expect(() => parseReviewerOutput("codex", Buffer.from(JSON.stringify({ verdict: "maybe", findings: [] })))).toThrow();
    expect(() => parseReviewerOutput("codex", Buffer.from(JSON.stringify({ verdict: "approve", findings: "none" })))).toThrow();
    expect(() => parseReviewerOutput("codex", Buffer.from("not json"))).toThrow();
    expect(() => parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: true, structured_output: review })))).toThrow();
    expect(() => parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: false, result: "approve" })))).toThrow();
  });

  it("skips per-invocation housekeeping for setup-review, which runs before any project exists", () => {
    expect(shouldSkipHousekeeping(["setup-review", "gate"])).toBe(true);
    expect(shouldSkipHousekeeping(["setup-review", "status", "--setup", "SS-00000000", "--skipped"])).toBe(true);
  });
});
