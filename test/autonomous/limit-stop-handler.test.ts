/**
 * T-534: `session limit-stop` is a tombstone. Installs that still carry the
 * StopFailure hook reach it; it runs only the retirement (mocked here, which
 * is covered in test/core/limit-retirement.test.ts), writes nothing to stdout,
 * creates no park, ledger record or waker, and never throws. Also
 * readHookStdinContext's StopFailure field extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

vi.mock("../../src/cli/limit-retirement-entry.js", () => ({
  retireLimitAutoResumeBestEffort: vi.fn(async () => ({ kind: "already" })),
}));

import { retireLimitAutoResumeBestEffort } from "../../src/cli/limit-retirement-entry.js";
import { handleSessionLimitStop, readHookStdinContext } from "../../src/cli/commands/session-compact.js";

const retire = vi.mocked(retireLimitAutoResumeBestEffort);
const TASK_ID = "task-limit-handler-0001";

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t534-tombstone-"));
  globalDir = mkdtempSync(join(tmpdir(), "t534-tombstone-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  mkdirSync(join(root, ".story", "sessions", "s1"), { recursive: true });
  writeFileSync(join(root, ".story", "sessions", "s1", "state.json"), '{"state":"IMPLEMENT"}\n');
  retire.mockClear();
  retire.mockImplementation(async () => ({ kind: "already" }));
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe("session limit-stop tombstone", () => {
  it("runs only the retirement: no stdout, no park, no ledger", async () => {
    const out = vi.spyOn(process.stdout, "write");
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", permissionMode: "bypassPermissions" });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveBeenCalled();
    expect(readdirSync(globalDir)).toEqual([]);
    expect(readFileSync(join(root, ".story", "sessions", "s1", "state.json"), "utf-8")).toBe('{"state":"IMPLEMENT"}\n');
  });

  it("runs the retirement for any error type or none", async () => {
    await handleSessionLimitStop({ errorType: "overloaded" });
    await handleSessionLimitStop();
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it("never throws, even when the retirement does", async () => {
    retire.mockImplementation(async () => {
      throw new Error("boom");
    });
    await expect(handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root })).resolves.toBeUndefined();
  });
});

describe("readHookStdinContext StopFailure fields", () => {
  async function parse(payload: Record<string, unknown>): Promise<Awaited<ReturnType<typeof readHookStdinContext>>> {
    const stream = new PassThrough();
    stream.end(JSON.stringify(payload));
    return readHookStdinContext(stream);
  }

  it("surfaces error_type, permission_mode, and hook_event_name", async () => {
    const ctx = await parse({
      session_id: TASK_ID,
      cwd: "/tmp/x",
      transcript_path: "/tmp/x/t.jsonl",
      error_type: "rate_limit",
      permission_mode: "bypassPermissions",
      hook_event_name: "StopFailure",
    });
    expect(ctx.sessionId).toBe(TASK_ID);
    expect(ctx.errorType).toBe("rate_limit");
    expect(ctx.permissionMode).toBe("bypassPermissions");
    expect(ctx.hookEventName).toBe("StopFailure");
  });

  it("accepts the `error` spelling as errorType", async () => {
    const ctx = await parse({ session_id: TASK_ID, error: "rate_limit" });
    expect(ctx.errorType).toBe("rate_limit");
  });

  it("drops oversized permission_mode values", async () => {
    const ctx = await parse({ session_id: TASK_ID, permission_mode: "x".repeat(65) });
    expect(ctx.permissionMode).toBeUndefined();
  });
});
