/**
 * ISS-1214 acceptance (c), pinned in-process: the prompt hook drives the
 * caller's own session to IMPERATIVE, the REGISTERED storybloq_handover_create
 * handler stamps the record, and the next three prompts are silent. The
 * negative half: an unbound MCP caller is told the stamp did not land and why,
 * and never gets the positive restart hint, which is a causal claim reserved
 * for a server proven stale.
 *
 * Cross-layer trust violation guard: the hook (reader) and the MCP write tool
 * (writer of the stamp) are two processes in production; each half's own
 * tests pass while the field report showed them disagreeing. This file
 * crosses the boundary in one process with no seam between them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { ensureCapture } from "../../src/core/session-intel/capture.js";
import { readPresenceRecord } from "../../src/core/session-intel/presence-bridge.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { handleSessionIntelPrompt } from "../../src/cli/commands/session-intel.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { HANDOVER_STAMP_STALE_NOTE, HANDOVER_STAMP_UNBOUND_LINE } from "../../src/core/output-formatter.js";
import { SID, assistantRecord, userRecord, writeTranscript } from "../core/session-intel-fixtures.js";

const CEILING = 0.925 * 450_000;
/** Inside the imperative band (60,000 tokens of headroom to 98% of the ceiling, T-533), clear of the 25,000-token re-arm cap. */
const IMPERATIVE_TOKENS = Math.ceil(0.9 * CEILING) + 5_000;

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => {
      tools.set(name, { handler });
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

interface Fx { base: string; root: string; projects: string; userSettings: string }

async function makeFixture(): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "iss1214-stamp-")));
  const root = join(base, "proj");
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "stamp" });
  const projects = join(base, "home", ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const userSettings = join(base, "home", ".claude", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
  return { base, root, projects, userSettings };
}

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");
const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;

const saved = { HOME: process.env.HOME, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, STORYBLOQ_CLIENT: process.env.STORYBLOQ_CLIENT, CLAUDE_PID: process.env.CLAUDE_PID };
let fx: Fx;

beforeEach(async () => {
  fx = await makeFixture();
  // The registered handler has no projectsDir seam: it resolves
  // ~/.claude/projects and ~/.claude/settings.json from HOME, exactly as the
  // production server does.
  process.env.HOME = join(fx.base, "home");
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  process.env.CLAUDE_PID = String(process.pid);
  delete process.env.STORYBLOQ_CLIENT;
  processEra.reset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  processEra.reset();
  rmSync(fx.base, { recursive: true, force: true });
});

const seams = (f: Fx) => ({ cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });

/** Binds the caller at startup and drives one prompt-hook sample to IMPERATIVE on the real clock. */
function driveToImperative(f: Fx, start: number): { lines: string[]; path: string } {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: start - 30 * 60_000, userSettingsPath: f.userSettings });
  const lines = [assistantRecord({ ts: new Date(start - 60_000).toISOString(), read: IMPERATIVE_TOKENS - 2 })];
  const path = writeTranscript(f.projects, encoded(f.root), SID, lines);
  const r = handleSessionIntelPrompt({ sessionId: SID, transcriptPath: path, now: start, ...seams(f) });
  expect(r.status, r.reason ?? "").toBe("emitted");
  expect(r.result?.pressure?.state).toBe("imperative");
  expect(r.output).toMatch(/Write a handover now with storybloq_handover_create/);
  return { lines, path };
}

describe("ISS-1214 (c): the registered storybloq_handover_create stamps the bound caller and the prompt hook holds for three prompts", () => {
  it("stamps, records the sample's tokens, and the next three prompts are silent", async () => {
    const start = Date.now();
    const { lines, path } = driveToImperative(fx, start);
    const before = intelOf(fx.root);
    expect(before.handoverWrittenAt).toBeNull();
    const tokens = before.lastSample!.contextTokens!;

    const tool = captureTools(fx.root).get("storybloq_handover_create")!;
    const reply = await tool.handler({ content: "# Handover\n\n## Summary\nISS-1214 (c).\n", slug: "iss1214-c" });
    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    const text = reply.content[0]!.text;
    expect(text).toMatch(/Created handover: /);
    expect(text, "the reply says the stamp landed and answers the notice").toMatch(/Handover recorded: it covers this compaction and the notice will not ask again before it\. Written on the context-pressure notice \([0-9,]+ of about [0-9,]+ tokens in use, 9[0-9]%\)\./);
    expect(text).not.toMatch(/did not land/);

    const after = intelOf(fx.root);
    expect(after.handoverWrittenAt, "the record carries the stamp").not.toBeNull();
    expect(after.tokensAtHandover, "the stamp records the sample it saw").toBe(tokens);
    expect(after.handoverFile).toMatch(/iss1214-c\.md$/);

    for (let i = 1; i <= 3; i++) {
      const now = Date.now() + i * 1000;
      lines.push(userRecord({ ts: new Date(now).toISOString(), text: `prompt ${i}` }));
      writeTranscript(fx.projects, encoded(fx.root), SID, lines);
      const r = handleSessionIntelPrompt({ sessionId: SID, transcriptPath: path, now, ...seams(fx) });
      expect(r, `prompt ${i} after the stamp`).toMatchObject({ status: "silent", output: null });
      expect(r.reason, `prompt ${i}`).toMatch(/^state advisory/);
    }
    expect(intelOf(fx.root).lastSample).toMatchObject({ state: "advisory", rawState: "imperative", suppressedBy: "handover" });
  });

  it("an MCP caller with no session id is told the stamp did not land and why, without the positive restart hint", async () => {
    const start = Date.now();
    driveToImperative(fx, start);
    delete process.env.CLAUDE_CODE_SESSION_ID;

    const tool = captureTools(fx.root).get("storybloq_handover_create")!;
    const reply = await tool.handler({ content: "# Handover\n\n## Summary\nunbound.\n", slug: "iss1214-unbound" });
    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    const text = reply.content[0]!.text;
    expect(text).toMatch(/Created handover: /);
    expect(text).toMatch(/Handover stamp did not land \(skipped: no caller session id\)\. The notice is shown once per compaction, so it will not repeat; the handover is on disk\./);
    expect(text, "the hedged line, not the causal one").toContain(HANDOVER_STAMP_UNBOUND_LINE);
    expect(text, "a fresh server is never told it is stale").not.toContain(HANDOVER_STAMP_STALE_NOTE);
    expect(text).not.toMatch(/held at advisory/);
    expect(intelOf(fx.root).handoverWrittenAt, "nothing was stamped").toBeNull();
  });
});
