import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleFeedbackList,
  handleFeedbackCreate,
  handleFeedbackVote,
  buildCreateURL,
} from "../../../src/cli/commands/feedback.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../../../src/feedback/github-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/feedback/github-client.js")>("../../../src/feedback/github-client.js");
  return {
    ...actual,
    fetchIssues: vi.fn(),
    FeedbackClientError: class FeedbackClientError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  };
});

import { fetchIssues } from "../../../src/feedback/github-client.js";
import { spawn } from "node:child_process";

function mockIssueResult(issues: Array<Record<string, unknown>> = []) {
  return {
    issues: issues.map((i) => ({
      number: 1,
      title: "Test",
      body: "Body",
      labels: [{ name: "enhancement" }],
      reactions: { "+1": 3 },
      created_at: "2026-05-20T00:00:00Z",
      html_url: "https://github.com/Storybloq/storybloq/issues/1",
      ...i,
    })),
    rateLimitWarning: null,
  };
}

describe("handleFeedbackList", () => {
  it("formats markdown table with issues", async () => {
    vi.mocked(fetchIssues).mockResolvedValue(
      mockIssueResult([
        { number: 12, title: "Add dark mode", labels: [{ name: "enhancement" }], reactions: { "+1": 5 } },
        { number: 8, title: "Fix crash", labels: [{ name: "bug" }], reactions: { "+1": 1 } },
      ])
    );

    const result = await handleFeedbackList({}, "md");
    expect(result.output).toContain("Add dark mode");
    expect(result.output).toContain("Fix crash");
    expect(result.output).toContain("|");
  });

  it("returns JSON format", async () => {
    vi.mocked(fetchIssues).mockResolvedValue(
      mockIssueResult([{ number: 1, title: "Test" }])
    );

    const result = await handleFeedbackList({}, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.issues).toHaveLength(1);
  });

  it("shows empty message when no issues", async () => {
    vi.mocked(fetchIssues).mockResolvedValue(mockIssueResult([]));

    const result = await handleFeedbackList({}, "md");
    expect(result.output).toContain("No feedback");
  });
});

describe("buildCreateURL", () => {
  it("encodes title and body in URL", () => {
    const url = buildCreateURL("My Title", "feature", "Some details");
    expect(url).toContain("title=My+Title");
    expect(url).toContain("Some+details");
    expect(url).toContain("labels=enhancement");
  });

  it("appends CLI template footer to body", () => {
    const url = buildCreateURL("Title", "bug", "Body text");
    expect(url).toContain("storybloq+feedback+create");
  });
});

describe("handleFeedbackCreate", () => {
  it("validates non-empty title", async () => {
    const result = await handleFeedbackCreate("", "feature", "body");
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.output).toContain("Error");
  });
});

describe("handleFeedbackVote", () => {
  it("builds correct issue URL", async () => {
    const result = await handleFeedbackVote(42);
    expect(result.output).toContain("42");
  });

  it("validates positive issue number", async () => {
    const result = await handleFeedbackVote(0);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.output).toContain("Error");
  });
});

describe("feedback test isolation", () => {
  it("keeps spawn stubbed so no test opens a browser", () => {
    expect(vi.isMockFunction(spawn)).toBe(true);
  });
});
