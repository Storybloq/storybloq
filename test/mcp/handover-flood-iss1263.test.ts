/**
 * ISS-1263 acceptance: a replay of the 2026-09-24 flood. runnerkit-4c wrote
 * six handovers in an hour because the MCP server could not resolve its
 * process era, so every stamp was skipped ("process era unknown"), nothing
 * held the imperative, and the prompt hook re-fired it on every prompt.
 *
 * The two halves run in one process, as in the ISS-1214 file: the prompt hook
 * binds by the process era (CLAUDE_PID set), and the registered
 * storybloq_handover_create runs with the era unresolvable (CLAUDE_PID unset),
 * which is the field shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { ensureCapture } from "../../src/core/session-intel/capture.js";
import { readPresenceRecord } from "../../src/core/session-intel/presence-bridge.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { handleSessionIntelPrompt } from "../../src/cli/commands/session-intel.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { SID, assistantRecord, userRecord, writeTranscript } from "../core/session-intel-fixtures.js";

const CEILING = 0.925 * 450_000;
/** Inside the imperative band, below the compact line (98% of the ceiling, T-533). */
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), "iss1263-flood-")));
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

const NINE_MIN = 9 * 60_000;

function hookBinds(): void { process.env.CLAUDE_PID = String(process.pid); processEra.reset(); }
function serverCannotResolveEra(): void { delete process.env.CLAUDE_PID; processEra.reset(); }

function startSession(f: Fx, start: number): { lines: string[]; path: string } {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: start - 30 * 60_000, userSettingsPath: f.userSettings });
  const lines = [assistantRecord({ ts: new Date(start - 60_000).toISOString(), read: IMPERATIVE_TOKENS - 2 })];
  return { lines, path: writeTranscript(f.projects, encoded(f.root), SID, lines) };
}

/** One prompt at `now`, the context grown by `grow` tokens. */
function prompt(f: Fx, s: { lines: string[]; path: string }, now: number, i: number, grow: number) {
  s.lines.push(userRecord({ ts: new Date(now - 2_000).toISOString(), text: `prompt ${i}` }));
  s.lines.push(assistantRecord({ ts: new Date(now - 1_000).toISOString(), read: IMPERATIVE_TOKENS - 2 + grow }));
  writeTranscript(f.projects, encoded(f.root), SID, s.lines);
  hookBinds();
  return handleSessionIntelPrompt({ sessionId: SID, transcriptPath: s.path, now, ...seams(f) });
}

describe("ISS-1263: the handover flood replay", () => {
  it("six prompts at 9-minute spacing, each followed by handover_create from a server that cannot resolve its era: ONE imperative line, and every handover lands an unbound-era stamp", async () => {
    const start = Date.now();
    const s = startSession(fx, start);
    const tool = captureTools(fx.root).get("storybloq_handover_create")!;
    // The registered handler takes no clock, so Date itself is moved to each
    // cycle's time: the prompt and the handover of one cycle happen at the
    // same instant, as in the field sequence. Timers stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    const emitted: number[] = [];
    let stamps = 0;
    try {
      for (let i = 0; i < 6; i++) {
        const now = start + i * NINE_MIN;
        vi.setSystemTime(now);
        const r = prompt(fx, s, now, i, i * 1_000);
        if (r.status === "emitted") {
          expect(r.output).toMatch(/Write a handover now/);
          emitted.push(i);
        }
        serverCannotResolveEra();
        const before = intelOf(fx.root).handoverWrittenAt;
        const reply = await tool.handler({ content: `# Handover ${i}\n\nunchanged.\n`, slug: `flood-${i}` });
        expect(reply.isError, reply.content[0]?.text).toBeUndefined();
        const text = reply.content[0]!.text;
        expect(text).toMatch(/Created handover: /);
        expect(text, `reply ${i}`).toMatch(/Handover recorded: it covers this compaction and the notice will not ask again before it\. Written on the context-pressure notice/);
        expect(text).not.toMatch(/next imperative is expected/);
        expect(text).not.toMatch(/restart/i);
        const after = intelOf(fx.root);
        expect(after.handoverStampBinding, `stamp ${i}`).toBe("unbound-era");
        expect(after.handoverWrittenAt, `stamp ${i} is this cycle's`).toBe(new Date(now).toISOString());
        if (after.handoverWrittenAt !== before) stamps++;
      }
    } finally {
      vi.useRealTimers();
    }
    expect(emitted, "exactly one imperative line across the six prompts").toEqual([0]);
    expect(stamps, "one unbound-era stamp per handover_create").toBe(6);
  });

  it("ISS-1428: with no stamp ever landing, the notice is delivered once in the era, never again on time or growth", () => {
    const start = Date.now();
    const s = startSession(fx, start);
    const emittedAt: number[] = [];
    for (let i = 0; i < 6; i++) {
      const now = start + i * NINE_MIN;
      const r = prompt(fx, s, now, i, i * 1_000);
      if (r.status === "emitted") emittedAt.push(now);
      else expect(r.reason, `prompt ${i}`).toMatch(/no notice due/);
    }
    expect(emittedAt).toEqual([start]);
    expect(intelOf(fx.root).handoverWrittenAt).toBeNull();
  });

});
