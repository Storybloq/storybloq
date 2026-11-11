import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { writeVerifiedPilot } from "./continuity-pilot-fixture.js";
import {
  parseStream, summarizeStream, usageContext, validity, rateLimitStop, machineLoadStop, parseSwapFree, LOAD_RULE, completion, sanitize, publicationCheck, jsonShapePreserved, fixtureCredentialAllowlist, environmentSecrets, ambiguousEnvironmentSecrets,
  diffLedger, decideCell, qualifies, expectedCellKeys, experimentHash, materialize, variantDiscoveryViolations, skillPayloadDiff, hashInputs, hashTree, sha256,
  verifyAttemptDir, isWellFormedEvent, TASKS, REPEATS, MAX_INVALID_RETRIES, type ValidityInputs, LAUNCH_POLICY, recordEligible, PILOT_EVIDENCE, PILOT_FILE, PILOT_PROBES,
  TASK_MATERIAL, taskMaterialEntries, taskMaterial, hashInputsByPath, driftedPaths, classifyInputDrift, NON_EXECUTED_INPUTS, INPUT_PATHS as LIB_INPUT_PATHS,
} from "../../scripts/continuity-lib.js";
import {
  parseArgs, buildManifestHash, readAttempts, INPUT_PATHS, checkOutputPaths, effectiveConfigHash, commandTokens, SHARED_REFUSAL, refuseShared, continuityTools, continuityOptions,
  provisionFreshConfig, runAttempt, runMatrix, runPilot, driveClaude, type Launch, RateLimitStopError, MachineLoadStopError, ConfigDriftStopError, pluginInventoryHash, bracketedInputs, EVAL_MCP_BUNDLE, codexFingerprint, type Preflight, type RunOptions, type SpawnFn,
} from "../../scripts/continuity-run.js";
import { aggregate, COMPARISON_CHECKPOINT, scoringRequest, validateScore, mechanicalFailureScore, selectObservations, renderReport, loadScore, publishText, type AttemptRecord, type Observation,
  taskMaterialOf, experimentTaskMaterial, compareTaskMaterial, type TaskMaterialResult } from "../../scripts/continuity-score.js";
import { SessionKilledError } from "../../scripts/headless-common.js";
import { processGroupSeams } from "../../src/core/process-group.js";

const PKG = resolve(__dirname, "../..");
const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

/** A record in the verified schema; tests override what they care about. */
function baseRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { validity: "valid", experimentHash: "x".repeat(64), completed: true, evidenceComplete: true, task: "T-4", repeat: 1, attempt: 1, arm: 1, completion: "completed", completionReason: "ok", requiredArtefacts: [], invalidReasons: [], wallMs: 1000, launchPolicy: LAUNCH_POLICY, ...over };
}

/** Writes an attempt directory the way the runner does: files, record.json, a manifest covering all of them, the completed marker. */
function writeAttempt(dir: string, record: Record<string, unknown>, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [f, c] of Object.entries(files)) { writeFileSync(join(dir, f), c); hashes[f] = sha256(c); }
  const recordText = JSON.stringify(record, null, 2);
  writeFileSync(join(dir, "record.json"), recordText); hashes["record.json"] = sha256(recordText);
  writeFileSync(join(dir, "artefacts.sha256.json"), JSON.stringify(hashes));
  writeFileSync(join(dir, "completed"), "t");
}

function ev(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ type, session_id: "s", uuid: "u", ...extra });
}
function assistant(reqId: string, content: unknown[], usage: Record<string, number> | undefined, parent: string | null = null, model = "claude-opus-5"): string {
  return ev("assistant", { request_id: reqId, parent_tool_use_id: parent, message: { model, role: "assistant", usage, content } });
}
function toolResult(id: string, text: string, parent: string | null = null): string {
  return ev("user", { parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
}
const guide = "mcp__storybloq__storybloq_autonomous_guide";
const SID = "11111111-2222-4333-8444-555555555555";
const stateLine = (s: string): string => `instruction\n\n---\n**Session:** ${SID}\n**State:** ${s}\n`;
const u = (input: number, create: number, read: number): Record<string, number> => ({ input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: read, output_tokens: 5 });
const INIT = ev("system", { subtype: "init", claude_code_version: "2.1.278", model: "claude-opus-5", mcp_servers: [{ name: "storybloq", status: "connected" }], skills: ["story"], plugins: [] });
/** ISS-1486: the pinned storybloq tools, and the init event the launch policy accepts (Agent among the built-ins). */
const TOOLS = continuityTools();
const POLICY_INIT = ev("system", { subtype: "init", claude_code_version: "2.1.322", model: "claude-opus-5", permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }],
  tools: [...continuityOptions("high").builtInTools, ...TOOLS.map((t) => `mcp__storybloq__${t}`)], skills: ["story"], plugins: [] });
const PILOT_OK = { ok: true as const, id: "pilot-1" };
/** A verified pilot for one arm: a real one the runner published, relabelled (G4: the reader recomputes it from its evidence). */
function writePilot(expDir: string, experiment = "e".repeat(64), arm = 1): void {
  writeVerifiedPilot(expDir, experiment, arm);
}

/** A synthetic stream in the real shape: init, start call -> PLAN, discovery reads, plan_written, a subagent turn, result. */
function syntheticStream(): string {
  return [
    INIT,
    assistant("r1", [{ type: "tool_use", id: "t1", name: guide, input: { sessionId: null, action: "start", targetWork: ["T-2"] } }], u(10, 3000, 10000)),
    assistant("r1", [{ type: "text", text: "dup block same request" }], u(10, 3000, 10000)),
    toolResult("t1", stateLine("PLAN")),
    assistant("r2", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/src/platform/logging/AppLogger.ts" } }], u(20, 0, 14000)),
    toolResult("t2", "export class AppLogger { ... Bearer abc ... }"),
    assistant("r3", [{ type: "tool_use", id: "t3", name: guide, input: { sessionId: SID, action: "report", report: { completedAction: "plan_written" } } }], u(30, 500, 15000)),
    toolResult("t3", stateLine("PLAN_REVIEW")),
    assistant("r4", [{ type: "text", text: "subagent reviewer" }], u(1, 1, 1), "t9", "claude-sonnet-5"),
    assistant("r5", [{ type: "tool_use", id: "t5", name: guide, input: { sessionId: SID, action: "report", report: { completedAction: "plan_written" } } }], u(40, 0, 16000)),
    toolResult("t5", stateLine("IMPLEMENT")),
    ev("result", { subtype: "success", total_cost_usd: 1.25, num_turns: 6, usage: {} }),
  ].join("\n") + "\n";
}

describe("stream parsing and token accounting", () => {
  it("dedupes by request_id, excludes subagents, and locates PLAN entry and before-plan-written", () => {
    const { events, truncatedTail, corruptLines } = parseStream(syntheticStream());
    expect(truncatedTail).toBeNull();
    expect(corruptLines).toBe(0);
    const { usage, toolCalls } = summarizeStream(events);
    expect(usage.planEntryContext).toBe(20 + 0 + 14000);
    expect(usage.planEntries).toEqual([14020]);
    // Rubric: the request that issued the first plan_written call.
    expect(usage.beforePlanWrittenContext).toBe(15530);
    expect(usage.mainRequests).toBe(4);
    expect(usage.totalInputTokens).toBe(13010 + 14020 + 15530 + 16040);
    expect(usage.mainModels).toEqual(["claude-opus-5"]);
    expect(usage.subagentModels).toEqual(["claude-sonnet-5"]);
    expect(usage.guideSessionId).toBe(SID);
    expect(usage.guideStates.map((g) => g.state)).toEqual(["PLAN", "PLAN_REVIEW", "IMPLEMENT"]);
    expect(usage.firstPlanWrittenToolUseId).toBe("t3");
    expect(toolCalls.find((t) => t.toolUseId === "t2")!.beforeFirstPlanWritten).toBe(true);
    expect(toolCalls.find((t) => t.toolUseId === "t5")!.beforeFirstPlanWritten).toBe(false);
    expect((usage.resultEvent as { total_cost_usd: number }).total_cost_usd).toBe(1.25);
  });

  it("a checkpoint request without usage yields null; no other request's usage is substituted", () => {
    const lines = [
      assistant("a", [{ type: "tool_use", id: "x1", name: guide, input: {} }], u(5, 0, 100)), toolResult("x1", stateLine("PLAN")),
      assistant("b", [{ type: "text", text: "no usage on this request" }], undefined),
      assistant("c", [{ type: "tool_use", id: "x2", name: guide, input: { report: { completedAction: "plan_written" } } }], undefined),
      toolResult("x2", stateLine("PLAN_REVIEW")),
      assistant("d", [{ type: "text", text: "later" }], u(99, 0, 0)),
    ].join("\n");
    const { usage } = summarizeStream(parseStream(lines).events);
    expect(usage.planEntries).toEqual([null]);
    expect(usage.planEntryContext).toBeNull();
    expect(usage.beforePlanWrittenContext).toBeNull();
  });

  it("includes cache creation in the context sum and tolerates a missing usage block", () => {
    expect(usageContext({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 })).toBe(6);
    expect(usageContext({ input_tokens: 1 })).toBe(1);
    expect(usageContext(undefined)).toBeNull();
    expect(usageContext({ cache_read_input_tokens: 3 })).toBeNull();
  });

  it("reports exactly one incomplete final line as truncation and everything else malformed as corruption", () => {
    const tail = parseStream(`${syntheticStream()}{"type":"assistant","message":{"usa`);
    expect(tail.truncatedTail).toContain('"type":"assistant"');
    expect(tail.corruptLines).toBe(0);
    expect(tail.events.length).toBe(12);
    const middle = parseStream(`${INIT}\nnot json at all\nnull\n[1,2]\n{"noType":true}\n${assistant("z", [], u(1, 0, 0))}\n`);
    expect(middle.corruptLines).toBe(4);
    expect(middle.truncatedTail).toBeNull();
    expect(middle.events.length).toBe(2);
    expect(middle.corruptSamples[0]).toBe("not json at all");
    expect(() => summarizeStream(middle.events)).not.toThrow();
    // A newline-terminated malformed final line is corruption, not truncation.
    const terminated = parseStream("{broken}\n");
    expect(terminated.truncatedTail).toBeNull();
    expect(terminated.corruptLines).toBe(1);
    // Envelope shapes summarizeStream consumes are validated, so a null block cannot crash it.
    const nullBlock = parseStream(`${ev("assistant", { request_id: "q", parent_tool_use_id: null, message: { model: "m", content: [null] } })}\n`);
    expect(nullBlock.corruptLines).toBe(1);
    expect(nullBlock.events).toEqual([]);
    expect(isWellFormedEvent({ type: "user", message: { content: "text" } })).toBe(true);
    expect(isWellFormedEvent({ type: "assistant", message: { usage: null } })).toBe(false);
    expect(isWellFormedEvent({ type: "assistant", message: "nope" })).toBe(false);
    expect(() => summarizeStream(nullBlock.events)).not.toThrow();
  });

  it("records every PLAN entry when a reject routes back, the first being the headline", () => {
    const lines = [
      assistant("a", [{ type: "tool_use", id: "x1", name: guide, input: {} }], u(5, 0, 100)), toolResult("x1", stateLine("PLAN")),
      assistant("b", [{ type: "text", text: "plan" }], u(5, 0, 200)),
      assistant("c", [{ type: "tool_use", id: "x2", name: guide, input: {} }], u(5, 0, 300)), toolResult("x2", stateLine("PLAN")),
      assistant("d", [{ type: "text", text: "again" }], u(5, 0, 400)),
    ].join("\n");
    const { usage } = summarizeStream(parseStream(lines).events);
    expect(usage.planEntries).toEqual([205, 405]);
    expect(usage.planEntryContext).toBe(205);
  });
});

describe("validity", () => {
  const base: ValidityInputs = {
    stateBinaryFingerprintSha256: "abc", builtMcpSha256: "abc", toolResults: ["ok"], mainModels: ["claude-opus-5"], pinnedModel: "claude-opus-5",
    distHashesExpected: { "dist/mcp.js": "abc", "dist/cli.js": "cli" }, distHashesBefore: { "dist/mcp.js": "abc", "dist/cli.js": "cli" }, distHashesAfter: { "dist/mcp.js": "abc", "dist/cli.js": "cli" }, configHashExpected: "c", configHashBefore: "c", configHashAfter: "c",
    streamCorrupt: false, initMcpServers: [{ name: "storybloq", status: "connected" }], interrupted: false, inputDriftInvalidating: [], rateLimitStop: null, machineLoadStop: null,
  };
  it("a clean run is valid", () => expect(validity(base)).toEqual({ valid: true, reasons: [] }));
  it("null fingerprint fails closed", () => expect(validity({ ...base, stateBinaryFingerprintSha256: null }).reasons).toEqual(["no-fingerprint"]));
  it("mismatched fingerprint", () => expect(validity({ ...base, stateBinaryFingerprintSha256: "zzz" }).reasons).toEqual(["server-fingerprint"]));
  it("stale note is a positive signal only", () => {
    expect(validity({ ...base, toolResults: ["Updated.\n\nServer binary is stale (fingerprint mismatch); restart the client."] }).reasons).toEqual(["stale-note"]);
    expect(validity({ ...base, toolResults: [] }).valid).toBe(true);
  });
  it("mcp provenance needs the one storybloq server affirmatively connected", () => {
    expect(validity({ ...base, initMcpServers: [{ name: "storybloq", status: "connected" }, { name: "codex-bridge", status: "connected" }] }).reasons).toEqual(["mcp-servers"]);
    expect(validity({ ...base, initMcpServers: null }).reasons).toEqual(["mcp-servers"]);
    expect(validity({ ...base, initMcpServers: [{ name: "storybloq" }] }).reasons).toEqual(["mcp-servers"]);
    expect(validity({ ...base, initMcpServers: [{ name: "storybloq", status: "" }] }).reasons).toEqual(["mcp-servers"]);
    expect(validity({ ...base, initMcpServers: [{ name: "storybloq", status: "failed" }] }).reasons).toEqual(["mcp-servers"]);
  });
  it("model drift, build drift, config drift against the experiment, stream corruption, interrupted", () => {
    expect(validity({ ...base, mainModels: ["claude-opus-5", "claude-sonnet-5"] }).reasons).toEqual(["model-drift"]);
    expect(validity({ ...base, mainModels: [] }).reasons).toEqual(["model-drift"]);
    expect(validity({ ...base, distHashesAfter: { "dist/mcp.js": "abc", "dist/cli.js": "new" } }).reasons).toEqual(["build-drift"]);
    // Drift against the preflight manifest is drift even when before and after agree with each other.
    expect(validity({ ...base, distHashesBefore: { "dist/mcp.js": "abc", "dist/cli.js": "new" }, distHashesAfter: { "dist/mcp.js": "abc", "dist/cli.js": "new" } }).reasons).toEqual(["build-drift"]);
    expect(validity({ ...base, distHashesBefore: { "dist/mcp.js": "abc" }, distHashesAfter: { "dist/mcp.js": "abc" } }).reasons).toEqual(["build-drift"]);
    expect(validity({ ...base, configHashAfter: "d" }).reasons).toEqual(["config-drift"]);
    expect(validity({ ...base, configHashBefore: "d", configHashAfter: "d" }).reasons).toEqual(["config-drift"]);
    expect(validity({ ...base, streamCorrupt: true }).reasons).toEqual(["stream-corrupt"]);
    expect(validity({ ...base, interrupted: true }).reasons).toEqual(["interrupted"]);
  });
  it("ISS-1274: an invalidating input drift is its own reason; an empty list leaves the run valid", () => {
    expect(validity({ ...base, inputDriftInvalidating: ["src"] }).reasons).toEqual(["input-drift"]);
    expect(validity({ ...base, inputDriftInvalidating: [] })).toEqual({ valid: true, reasons: [] });
  });
  it("B2: a rate-limit or overload stop is its own reason", () => {
    expect(validity({ ...base, rateLimitStop: "result api_error_status 429" })).toEqual({ valid: false, reasons: ["rate-limited"] });
  });
  it("a load-rule invalidation is its own reason", () => {
    expect(validity({ ...base, machineLoadStop: "load rule breached for 5 min from +0 min" })).toEqual({ valid: false, reasons: ["machine-load"] });
  });
});

describe("machineLoadStop (pre-registered load rule)", () => {
  const GB = 1024 ** 3;
  const run = (n: number, over: { load1?: number | null; swapFreeBytes?: number | null } = {}, stepMs = 60_000, t0 = 0) =>
    Array.from({ length: n }, (_, i) => ({ t: t0 + i * stepMs, load1: 16, swapFreeBytes: 4 * GB, ...over }));
  const quiet = (t: number) => ({ t, load1: 2, swapFreeBytes: 4 * GB });
  it("the rule is the ruled one: load1 over 15 for 5 consecutive minutes; swap is recorded, never decides", () => {
    expect(LOAD_RULE).toEqual({ load1Over: 15, minMs: 300_000, sampleMs: 60_000, maxGapMs: 90_000 });
  });
  it("only a timeout qualifies; a completed or otherwise ended attempt is never invalidated for load", () => {
    expect(machineLoadStop("timeout", run(6))).toBe("load rule breached for 5 min from +0 min");
    for (const k of [null, "external-kill", "runner-signal"]) expect(machineLoadStop(k, run(20))).toBeNull();
  });
  it("five minutes of consecutive breach is required; four is not enough", () => {
    expect(machineLoadStop("timeout", run(5))).toBeNull();
    expect(machineLoadStop("timeout", [quiet(0), ...run(6, {}, 60_000, 60_000)])).toBe("load rule breached for 5 min from +1 min");
  });
  it("load1 alone decides; the threshold is strict; low free swap never breaches; an unreadable figure is not a breach", () => {
    expect(machineLoadStop("timeout", run(6, { load1: 2, swapFreeBytes: 0 }))).toBeNull();
    expect(machineLoadStop("timeout", run(6, { load1: 16, swapFreeBytes: null }))).not.toBeNull();
    expect(machineLoadStop("timeout", run(6, { load1: 15 }))).toBeNull();
    expect(machineLoadStop("timeout", run(6, { load1: 2, swapFreeBytes: GB }))).toBeNull();
    expect(machineLoadStop("timeout", run(6, { load1: null, swapFreeBytes: null }))).toBeNull();
  });
  it("a quiet sample or a missed sample (a gap over 90 s) breaks the run instead of bridging it", () => {
    const broken = [...run(3), quiet(180_000), ...run(3, {}, 60_000, 240_000)];
    expect(machineLoadStop("timeout", broken)).toBeNull();
    expect(machineLoadStop("timeout", [...run(3), ...run(3, {}, 60_000, 300_000)])).toBeNull();
    expect(machineLoadStop("timeout", run(11, {}, 30_000))).toBe("load rule breached for 5 min from +0 min");
  });
  it("parses macOS vm.swapusage free figures", () => {
    expect(parseSwapFree("total = 6144.00M  used = 5553.00M  free = 591.00M  (encrypted)")).toBe(591 * 1024 ** 2);
    expect(parseSwapFree("total = 8.00G  used = 6.50G  free = 1.50G  (encrypted)")).toBe(1.5 * GB);
    expect(parseSwapFree("free = 512.00K")).toBe(512 * 1024);
    expect(parseSwapFree("no swap here")).toBeNull();
  });
});

describe("rateLimitStop (B2)", () => {
  const started = [INIT, assistant("r1", [{ type: "text", text: "working" }], u(10, 0, 100))];
  const events = (...lines: string[]) => parseStream([...started, ...lines].join("\n")).events;
  const limit = (status: string, extra: Record<string, unknown> = {}): string => ev("rate_limit_event", { rate_limit_info: { status, rateLimitType: "five_hour", overageStatus: "rejected", ...extra } });
  const errorResult = (status: number | null): string => ev("result", { subtype: "success", is_error: true, api_error_status: status, result: "API Error", num_turns: 1 });
  const apiError = (error: string, parent: string | null = null): string => ev("assistant", { request_id: "rx", parent_tool_use_id: parent, error, message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error" }] } });
  const retry = (status: number | null): string => ev("system", { subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 30000, error_status: status, error: status === 529 ? "overloaded" : "rate_limit" });

  it("an error result carrying 429 or 529 is a stop; another API status is not", () => {
    expect(rateLimitStop(events(errorResult(429)))).toBe("result api_error_status 429");
    expect(rateLimitStop(events(errorResult(529)))).toBe("result api_error_status 529");
    expect(rateLimitStop(events(errorResult(500)))).toBeNull();
    expect(rateLimitStop(events(errorResult(null)))).toBeNull();
  });
  it("a session whose result is not an error was not stopped, whatever it saw on the way", () => {
    expect(rateLimitStop(events(limit("rejected"), apiError("rate_limit"), ev("result", { subtype: "success", is_error: false, api_error_status: 429 })))).toBeNull();
  });
  it("the final main-session message carrying rate_limit or overloaded is a stop; a subagent's or an earlier one is not", () => {
    expect(rateLimitStop(events(apiError("rate_limit"), errorResult(null)))).toBe("final assistant error rate_limit");
    expect(rateLimitStop(events(apiError("overloaded")))).toBe("final assistant error overloaded");
    expect(rateLimitStop(events(apiError("server_error"), errorResult(500)))).toBeNull();
    // A final non-limit error settles it: a rejected limit event trailing it in the quiet tail must not reclassify it.
    expect(rateLimitStop(events(apiError("billing_error"), limit("rejected"), errorResult(null)))).toBeNull();
    expect(rateLimitStop(events(apiError("rate_limit", "toolu_sub"), errorResult(null)))).toBeNull();
    expect(rateLimitStop(events(apiError("overloaded"), assistant("r2", [{ type: "text", text: "recovered" }], u(1, 0, 1)), errorResult(null)))).toBeNull();
  });
  it("a last rate_limit_event of rejected, with no paid overage covering it, is a stop, including under a timeout kill", () => {
    expect(rateLimitStop(events(limit("rejected")))).toBe("rate_limit_event rejected (five_hour)");
    expect(rateLimitStop(events(limit("rejected", { rateLimitType: "Weird Type!" }), errorResult(null)))).toBe("rate_limit_event rejected (unknown)");
    expect(rateLimitStop(events(limit("rejected", { overageStatus: "allowed" })))).toBeNull();
    expect(rateLimitStop(events(limit("rejected", { overageStatus: "allowed_warning" })))).toBeNull();
    expect(rateLimitStop(events(limit("allowed_warning")))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), limit("allowed")))).toBeNull();
  });
  it("a killed session whose last word is a 429/529 retry was stopped; a retry it recovered from, or another status, was not", () => {
    expect(rateLimitStop(events(retry(529)))).toBe("api_retry 529 with nothing after it");
    expect(rateLimitStop(events(retry(429)))).toBe("api_retry 429 with nothing after it");
    expect(rateLimitStop(events(retry(500)))).toBeNull();
    expect(rateLimitStop(events(retry(null)))).toBeNull();
    // The retry branch is only for a session that never produced a result: once a result exists, it settles the question.
    expect(rateLimitStop(events(retry(429), errorResult(null)))).toBeNull();
    expect(rateLimitStop(events(retry(529), assistant("r2", [{ type: "text", text: "recovered" }], u(1, 0, 1))))).toBeNull();
    expect(rateLimitStop(events(retry(529), errorResult(500)))).toBeNull();
  });
  it("a definitive error of another kind, or a refusal the session outlived, is never read as a limit", () => {
    expect(rateLimitStop(events(limit("rejected"), errorResult(400)))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), apiError("invalid_request")))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), assistant("r2", [{ type: "text", text: "went on" }], u(1, 0, 1)), errorResult(null)))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), assistant("r2", [{ type: "text", text: "went on" }], u(1, 0, 1))))).toBeNull();
  });
  it("a refusal or retry followed by any progress (thinking, a subagent turn, a tool result) was survived", () => {
    const thinking = ev("system", { subtype: "thinking_tokens", tokens: 10 });
    const subTurn = assistant("rs", [{ type: "text", text: "sub" }], u(1, 0, 1), "toolu_sub");
    expect(rateLimitStop(events(retry(529), thinking))).toBeNull();
    expect(rateLimitStop(events(retry(429), subTurn))).toBeNull();
    expect(rateLimitStop(events(retry(529), toolResult("t9", "ok")))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), thinking))).toBeNull();
    expect(rateLimitStop(events(limit("rejected"), subTurn, errorResult(null)))).toBeNull();
    expect(rateLimitStop(events(retry(529), limit("allowed_warning"), retry(529)))).toBe("api_retry 529 with nothing after it");
  });
  it("a clean stream is not a stop", () => expect(rateLimitStop(events())).toBeNull());
});

describe("completion", () => {
  const done = { state: "SESSION_END", status: "completed", terminationReason: "normal", completedTickets: [{ id: "T-2" }] };
  const inputs = { stateJson: done, ticketId: "T-2", ticketStatusOnDisk: "complete", handoverWritten: true, headMoved: true };
  it("replays the real FINALIZE -> HANDOVER -> SESSION_END shape", () => expect(completion(inputs).status).toBe("completed"));
  it("COMPLETE left in state.json is incomplete", () => expect(completion({ ...inputs, stateJson: { ...done, state: "COMPLETE" } }).status).toBe("incomplete"));
  it("SESSION_END without the ticket in completedTickets is incomplete", () => expect(completion({ ...inputs, stateJson: { ...done, completedTickets: [] } }).status).toBe("incomplete"));
  it("SESSION_END without HEAD movement is completed-no-commit", () => expect(completion({ ...inputs, headMoved: false }).status).toBe("completed-no-commit"));
  it("no state, wrong status, open ticket, no handover", () => {
    expect(completion({ ...inputs, stateJson: null }).status).toBe("incomplete");
    expect(completion({ ...inputs, stateJson: { ...done, status: "failed" } }).status).toBe("incomplete");
    expect(completion({ ...inputs, ticketStatusOnDisk: "inprogress" }).status).toBe("incomplete");
    expect(completion({ ...inputs, handoverWritten: false }).status).toBe("incomplete");
  });
});

describe("sanitiser and publication", () => {
  const ctx = { workdir: "/private/tmp/continuity-work-abc", home: "/Users/someone", user: "someone", pkgRoot: "/Users/someone/Developer/CPM/storybloq" };
  it("substitutes workdir, socket, package, home and user in that order", () => {
    const s = sanitize("read /private/tmp/continuity-work-abc/src/x.ts and /Users/someone/.claude/settings.json via /tmp/cc-socks/1.sock by someone using /Users/someone/Developer/CPM/storybloq/dist/mcp.js", ctx);
    expect(s.text).toBe("read <WORKDIR>/src/x.ts and <HOME>/.claude/settings.json via <SOCK> by <USER> using <PKG>/dist/mcp.js");
    expect(s.substitutions.map((x) => x.pattern)).toEqual(["workdir", "cc-socks", "pkg", "home", "user"]);
  });
  it("allowlists exactly the fixture's synthetic credentials and blocks anything else", () => {
    const allow = fixtureCredentialAllowlist(join(FIXTURE, "core"));
    expect(allow).toContain("sk-abcdefghijk");
    const ok = publicationCheck("saw Bearer abc and Bearer ... and sk-abcdefghijk in N-1", allow);
    expect(ok.ok).toBe(true);
    // None of those three is long enough to be a credential, so none is blocked and none needs the allowlist:
    // a session implementing the fixture's redactor invents variants of them, and no allowlist can enumerate those.
    expect(publicationCheck("saw Bearer abc and sk-abcdefgh12345 and sk-abcdefghijk", []).ok).toBe(true);
    // At credential length they all refuse, allowlist or not.
    expect(publicationCheck(`token Bearer ${"x".repeat(40)}`, allow).blocked[0]!.label).toBe("bearer");
    expect(publicationCheck(`sk-ant-oat01-${"y".repeat(40)}`, allow).ok).toBe(false);
    expect(publicationCheck(`ANTHROPIC_API_KEY=${"z".repeat(40)}`, allow).ok).toBe(false);
    // A name is not a secret, and a word is not a token: both appear in prose about redaction. The floor is on
    // the VALUE, so a long variable name cannot push a short placeholder over it.
    expect(publicationCheck("redact ANTHROPIC_API_KEY and oauth tokens", allow).ok).toBe(true);
    expect(publicationCheck("ANTHROPIC_API_KEY=placeholder-token", allow).ok).toBe(true);
    expect(publicationCheck("Bearer short-placeholder-abc", allow).ok).toBe(true);
    // oauth keeps a positive case of its own: disabling the detector must not leave this suite green.
    expect(publicationCheck(`oauth-${"0123456789".repeat(4)}`, allow).blocked.map((b) => b.label)).toContain("oauth");
    // Allowlisting still works at credential length, and a derived hit is still accounted.
    const synthetic = `sk-ant-api03-${"synthetic".repeat(3)}`;
    expect(publicationCheck(`saw ${synthetic}`, []).ok).toBe(false);
    const derived = publicationCheck(`saw ${synthetic} twice: ${synthetic}`, [synthetic]);
    expect(derived.ok).toBe(true);
    // Two occurrences, each matched by both sk-ant and sk-key: the accounting counts pattern hits, not strings.
    expect(derived.fixtureDerived).toEqual([{ value: synthetic, count: 4 }]);
    // An explicitly known secret outranks both the allowlist and the floor, at any length.
    expect(publicationCheck("sk-ant-secret123", ["sk-ant-secret123"], { secrets: ["sk-ant-secret123"] }).blocked.map((b) => b.label)).toEqual(["known-secret"]);
    // An address identifies a person at any length, so the credential floor never applies to it.
    expect(publicationCheck("mail me at a@b.co", allow).ok).toBe(false);
  });
  it("blocks any absolute path regardless of root, honours directory boundaries on allowed prefixes, and admits public system prefixes", () => {
    const allow: string[] = [];
    expect(publicationCheck("<WORKDIR>/src/x.ts <HOME>/x <PKG>/dist/mcp.js", allow).ok).toBe(true);
    expect(publicationCheck("/Users/other/secret.txt", allow).blocked[0]!.label).toBe("absolute-path");
    expect(publicationCheck("/etc/private.conf", allow).ok).toBe(false);
    expect(publicationCheck("/Volumes/private/client.csv", allow).ok).toBe(false);
    expect(publicationCheck('{"p":"\\/Volumes\\/private\\/x"}', allow).ok).toBe(false);
    expect(publicationCheck("/opt/x/storybloq/dist/mcp.js", allow, { allowedAbsolutePrefixes: ["/opt/x/storybloq/dist"] }).ok).toBe(true);
    expect(publicationCheck("/opt/x/storybloq/dist-private/k", allow, { allowedAbsolutePrefixes: ["/opt/x/storybloq/dist"] }).ok).toBe(false);
    expect(publicationCheck("cat < /dev/null; /usr/bin/env node; /story auto T-2; https://github.com/Storybloq/x; src/http/router.ts", allow).ok).toBe(true);
    // Dot segments are normalised before the boundary check, for public and caller-supplied prefixes alike.
    expect(publicationCheck("/bin/../etc/private.conf", allow).blocked[0]!.sample).toBe("/etc/private.conf");
    expect(publicationCheck("/dev/../Users/x/y", allow).ok).toBe(false);
    expect(publicationCheck("/opt/x/dist/../secrets/k", allow, { allowedAbsolutePrefixes: ["/opt/x/dist"] }).ok).toBe(false);
  });
  it("scans JSON and JSONL artefacts by their decoded string values, so escapes cannot hide a credential or a path", () => {
    const allow: string[] = [];
    expect(publicationCheck(JSON.stringify({ content: "Bearer\nprivate-token-0123456789abcdef0123" }), allow).blocked[0]!.label).toBe("bearer");
    expect(publicationCheck('{"k":"\\u0042earer secret1-0123456789abcdef0123456789"}', allow).ok).toBe(false);
    expect(publicationCheck('{"p":"\\/Users\\/x\\/y"}', allow).ok).toBe(false);
    expect(publicationCheck([JSON.stringify({ a: "fine" }), JSON.stringify({ b: "sk-ant-api03-secret0123456789abcdef" })].join("\n"), allow).ok).toBe(false);
    expect(publicationCheck(JSON.stringify({ a: "<WORKDIR>/src/x.ts", b: "Bearer abc" }), ["Bearer abc"]).ok).toBe(true);
    // Keys are scanned too.
    expect(publicationCheck('{"Bearer\\u0020private-token-0123456789abcdef0123":1}', allow).blocked[0]!.label).toBe("bearer");
    expect(publicationCheck('{"\\/Users\\/x\\/secret":1}', allow).blocked[0]!.label).toBe("absolute-path");
    // An environment credential is the same credential whether it is written bare, shell-quoted or as JSON.
    const envValue = "0123456789abcdef0123456789abcdef";
    expect(publicationCheck(`ANTHROPIC_AUTH_TOKEN=${envValue}`, allow).blocked[0]!.label).toBe("anthropic-env");
    expect(publicationCheck(`export ANTHROPIC_AUTH_TOKEN="${envValue}"`, allow).blocked[0]!.label).toBe("anthropic-env");
    expect(publicationCheck(JSON.stringify({ ANTHROPIC_AUTH_TOKEN: envValue }), allow).blocked[0]!.label).toBe("anthropic-env");
    // An escaped key is the same assignment: the raw matcher cannot see it and decodedStrings hands the key and
    // the value over separately, so the pairs are rebuilt from the parsed form and scanned as assignments.
    expect(publicationCheck(`{"ANTHROPIC_AUTH_TO\\u004bEN":"${envValue}"}`, allow).blocked[0]!.label).toBe("anthropic-env");
    expect(publicationCheck(`{"nested":{"ANTHROPIC_API_KEY":"${envValue}"}}`, allow).blocked[0]!.label).toBe("anthropic-env");
    // The allowlist has to carry BOTH spellings the check scans, or a fixture's own assignment is matched in the
    // raw form (`NAME":"value`) and refused in the rebuilt one (`NAME=value`), which is unallowlistable content.
    const fx = tmp("cont-fxalw-");
    const doc = JSON.stringify({ ANTHROPIC_AUTH_TOKEN: envValue });
    writeFileSync(join(fx, "f.json"), doc);
    const fxAllow = fixtureCredentialAllowlist(fx);
    expect(publicationCheck(doc, fxAllow).ok).toBe(true);
    expect(publicationCheck(`{"ANTHROPIC_AUTH_TO\\u004bEN":"${envValue}"}`, fxAllow).ok).toBe(true);
    expect(publicationCheck(JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "f".repeat(32) }), fxAllow).ok).toBe(false);
    // An escaped credential inside an array, and a standalone JSON string, exist in NEITHER the raw text nor an
    // assignment: only the decoded value carries them. Both consumers read one enumeration, so both see them.
    const esc = tmp("cont-fxesc-");
    const inArray = `["\\u0042earer ${"x".repeat(32)}"]`;
    const standalone = `"\\u0042earer ${"y".repeat(32)}"`;
    writeFileSync(join(esc, "a.json"), inArray);
    writeFileSync(join(esc, "b.json"), standalone);
    const escAllow = fixtureCredentialAllowlist(esc);
    expect(publicationCheck(inArray, escAllow).ok).toBe(true);
    expect(publicationCheck(standalone, escAllow).ok).toBe(true);
    expect(publicationCheck(`["Bearer ${"z".repeat(32)}"]`, escAllow).blocked.map((b) => b.label)).toContain("bearer");
    expect(publicationCheck(`${JSON.stringify({ ok: 1 })}\n${JSON.stringify({ "/Volumes/private/k": 1 })}`, allow).ok).toBe(false);
  });
  // ISS: the 2026-09-20 arm-1 smoke cell was valid and completed but withheld evidence.jsonl
  // (2 emails, 30 absolute paths) and ledger.changes.json (1 absolute path), so it could not be
  // scored. The sanitiser knew only workdir/pkg/home/user; a live session also emits the
  // /private twin of its workdir, JSON-escaped paths, scratch files it invents, and third-party
  // addresses. The invariant below is the fix: whatever a session emits, the sanitised artefact
  // passes the publication check.
  describe("the sanitiser closes the publication check", () => {
    const allow = fixtureCredentialAllowlist(join(FIXTURE, "core"));
    const twinCtx = { workdir: "/var/folders/1l/xx/T/continuity-work-abc", home: "/Users/someone", user: "someone", pkgRoot: "/Users/someone/Developer/CPM/storybloq" };
    it("substitutes the /private twin of the workdir that macOS reports", () => {
      const s = sanitize("wrote /private/var/folders/1l/xx/T/continuity-work-abc/src/x.ts", twinCtx);
      expect(s.text).toBe("wrote <WORKDIR>/src/x.ts");
    });
    it("substitutes the twin in the other direction too", () => {
      const s = sanitize("wrote /var/folders/1l/xx/T/w/src/x.ts", { ...twinCtx, workdir: "/private/var/folders/1l/xx/T/w" });
      expect(s.text).toBe("wrote <WORKDIR>/src/x.ts");
    });
    it("substitutes escaped forms of the same roots (JSON.stringify does not escape a slash; some producers do)", () => {
      const escaped = String.raw`{"p":"\/Users\/someone\/.claude\/settings.json"}`;
      const s = sanitize(escaped, twinCtx);
      // Only the ROOT is substituted; the tail keeps the exact bytes it arrived with, escapes included.
      expect(s.text).toBe(String.raw`{"p":"<HOME>\/.claude\/settings.json"}`);
      expect(publicationCheck(s.text, allow).ok).toBe(true);
      const unicodeRoot = String.raw`{"p":"\u002fUsers\u002fsomeone\u002fx"}`;
      expect(publicationCheck(sanitize(unicodeRoot, twinCtx).text, allow).ok).toBe(true);
    });
    it("a credential inside a path is NOT erased: the path stays and the check refuses it", () => {
      const s = sanitize("wrote /tmp/sk-ant-api03-secret0123456789abcdef", twinCtx);
      expect(s.text).toBe("wrote /tmp/sk-ant-api03-secret0123456789abcdef");
      expect(publicationCheck(s.text, []).blocked.map((b) => b.label)).toContain("sk-ant");
    });
    it("a credential shaped as an address is NOT erased either", () => {
      const s = sanitize("mail sk-ant-api03-secret0123456789abcdef@example.com", twinCtx);
      expect(s.text).toBe("mail sk-ant-api03-secret0123456789abcdef@example.com");
      expect(publicationCheck(s.text, []).blocked.map((b) => b.label)).toContain("sk-ant");
    });
    it("replaces a percent-encoded file URL, whose decoded path matches nothing literal", () => {
      const s = sanitize("see file:///Users/other/My%20Folder/x.ts", twinCtx);
      expect(s.text).toBe("see <ABS>");
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("replaces a path hidden behind unicode escapes, which the check decodes and would have flagged", () => {
      const s = sanitize(String.raw`{"p":"\u002ftmp\u002fprivate.txt"}`, twinCtx);
      expect(s.text).toBe('{"p":"<ABS>"}');
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("replaces a scratch path the session invented, which no root can predict", () => {
      const s = sanitize("ran tsc > /tmp/tsc.out and diffed /tmp/t2.diff", twinCtx);
      expect(s.text).toBe("ran tsc > <ABS> and diffed <ABS>");
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("replaces a file URL", () => {
      expect(publicationCheck(sanitize("see file:///Users/other/x/y.ts", twinCtx).text, allow).ok).toBe(true);
    });
    it("leaves genuinely public prefixes alone", () => {
      const s = sanitize("cat < /dev/null; /usr/bin/env node", twinCtx);
      expect(s.text).toBe("cat < /dev/null; /usr/bin/env node");
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("replaces a third-party address but keeps the fixture's own synthetic credentials", () => {
      const s = sanitize("mail noreply@anthropic.com; the test uses Bearer abc", { ...twinCtx, allowlist: allow });
      expect(s.text).toBe("mail <EMAIL>; the test uses Bearer abc");
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    // Round 2: replacing candidate STRINGS let a harmless match erase bytes inside another match.
    // These four pin the span-based replacement that fixed it.
    it("a harmless path next to a credential-bearing one does not erase its neighbour's secret", () => {
      const s = sanitize("/tmp/sk-ant /tmp/sk-ant-api03-secret0123456789abcdef", twinCtx);
      expect(s.text).toBe("<ABS> /tmp/sk-ant-api03-secret0123456789abcdef");
      expect(publicationCheck(s.text, []).blocked.map((b) => b.label)).toContain("sk-ant");
    });
    it("matches a path written with a surrogate-pair escape", () => {
      const s = sanitize(String.raw`{"p":"/tmp/\ud801\udc00/file"}`, twinCtx);
      expect(s.text).toBe('{"p":"<ABS>"}');
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("matches a path written with mixed-case hex in the escape, which JSON permits", () => {
      const s = sanitize(String.raw`{"p":"/tmp/\u00eD/file"}`, twinCtx);
      expect(s.text).toBe('{"p":"<ABS>"}');
      expect(publicationCheck(s.text, allow).ok).toBe(true);
    });
    it("matches a file URL that is both slash-escaped and percent-encoded", () => {
      const s = sanitize(String.raw`{"p":"file:\/\/\/Users\/other\/My%20Folder\/x.ts"}`, twinCtx);
      expect(s.text).toBe('{"p":"<ABS>"}');
      expect(publicationCheck(s.text, allow).ok).toBe(true);
      expect(() => JSON.parse(s.text)).not.toThrow();
    });
    // Round 3: a credential can START outside the span being replaced, and a replacement must never
    // break a document that parsed before.
    it("a credential that swallows a path keeps its alarm", () => {
      const s = sanitize("Bearer /tmp/secret123-0123456789abcdef0123", twinCtx);
      expect(s.text).toBe("Bearer /tmp/secret123-0123456789abcdef0123");
      expect(publicationCheck(s.text, []).blocked.map((b) => b.label)).toContain("bearer");
    });
    it("a credential that swallows an address keeps its alarm, even through the username pass", () => {
      const s = sanitize("Bearer someone-0123456789abcdef0123456789@example.com", twinCtx);
      expect(s.text).toBe("Bearer someone-0123456789abcdef0123456789@example.com");
      expect(publicationCheck(s.text, []).blocked.map((b) => b.label)).toContain("bearer");
    });
    // Round 5: the arm-1 matrix lost T-2.a#1 and T-2.a#2 to two false refusals. Both are below, verbatim.
    it("a source file that opens with a JSDoc block is not an absolute path", () => {
      const body = "/**\n * Background jobs. A job records the request id it came from.\n */\nexport const run = () => 1;\n";
      const line = JSON.stringify({ tool: "Read", result: body });
      expect(publicationCheck(sanitize(line, twinCtx).text, allow).ok).toBe(true);
      // The bare and quoted matchers disagreed: the serialised form kept `\n` as two characters, so the
      // quoted branch read a whole file as one path. A quoted candidate is judged by what no path contains.
      expect(publicationCheck('opened "/Users/other/My Projects/app/src/index.ts"', []).blocked[0]!.label).toBe("absolute-path");
      expect(publicationCheck('note "/**\\n * not a path"', []).ok).toBe(true);
      expect(publicationCheck('/* eslint-disable */ export const x = 1;', []).ok).toBe(true);
      // Round 5 review: rejecting by allowed character set let an identifying path publish, whole or in part.
      // Parentheses, backslashes and asterisks are all legal in a POSIX filename, and the WHOLE span must be
      // replaced, not just the first segment the bare matcher reaches before a space.
      expect(sanitize('opened "/Acme (Confidential)/Client Files"', twinCtx).text).toBe('opened "<ABS>"');
      expect(sanitize('opened "/Volumes/Client Files/Acme (Confidential)/plan.txt"', twinCtx).text).toBe('opened "<ABS>"');
      expect(sanitize(JSON.stringify({ p: "/Volumes/Client Files/Acme\\Archive/Private Plans" }), twinCtx).text).toBe('{"p":"<ABS>"}');
      expect(sanitize(JSON.stringify({ p: "/*Client Files/Private Plans" }), twinCtx).text).toBe('{"p":"<ABS>"}');
      expect(sanitize(JSON.stringify({ p: "/*Client Files*/Private Plans" }), twinCtx).text).toBe('{"p":"<ABS>"}');
      // No character rule exempts a candidate, so a one-line source comment is substituted too. That costs a
      // line of published evidence and is the price of the rule being sound: a directory component may begin
      // and end with an asterisk, so a comment's shape can never prove a string is not a path.
      expect(sanitize(JSON.stringify({ result: "/* eslint-disable */ export const x = 1;" }), twinCtx).text).toBe('{"result":"<ABS>"}');
      // Escapes are decoded only where they mean something, and the SANITISER shares that one classification.
      // In plain text a backslash is a filename character; decoding it as a line break hid the rest of the path,
      // so the sanitiser replaced only the rooted head and the identifying tail published, unrefusable because
      // the check could no longer see a rooted path. Both inputs must substitute WHOLE, not partially.
      expect(sanitize('opened "/Client\\notes/Private Plans"', twinCtx).text).toBe('opened "<ABS>"');
      expect(sanitize('opened "/Volumes/Client Files/Acme\\notes/Private Plans"', twinCtx).text).toBe('opened "<ABS>"');
      // A JSONL file is classified line by line: a line that parses decodes, one that does not keeps its bytes.
      const jsonl = `${JSON.stringify({ p: "/Volumes/Client Files/a.txt" })}\nnot json "/Volumes/Other Files/b.txt"`;
      expect(sanitize(jsonl, twinCtx).text).toBe('{"p":"<ABS>"}\nnot json "<ABS>"');
    });
    it("a short bearer literal the agent wrote while implementing a redactor is content", () => {
      const code = JSON.stringify({ code: 'assert(redact({ Authorization: "Bearer abc123" })); // a Bearer token is replaced' });
      expect(publicationCheck(sanitize(code, twinCtx).text, allow).ok).toBe(true);
      // The literal that disqualified the SECOND capture: the same class, in a pattern nobody had watched.
      expect(publicationCheck(JSON.stringify({ code: 'redact({ token: "sk-abcdefgh12345" })' }), []).ok).toBe(true);
      // At credential length both refuse.
      expect(publicationCheck(`Bearer ${"a".repeat(32)}`, []).blocked.map((b) => b.label)).toContain("bearer");
      expect(publicationCheck(`sk-ant-oat01-${"b".repeat(40)}`, []).ok).toBe(false);
    });
    it("a value from the runner environment is refused by value, allowlist or not, and never printed", () => {
      const secret = `oat01-${"Z".repeat(40)}`;
      const v = publicationCheck(JSON.stringify({ log: `sent with ${secret}` }), [secret], { secrets: [secret] });
      expect(v.blocked.map((b) => b.label)).toContain("known-secret");
      expect(v.blocked.every((b) => !b.sample.includes("Z"))).toBe(true);
      // Escapes do not hide it either. A caller's own statement that a value is secret outranks the credential
      // floor entirely: the floor is a guess about unknown strings, and this is not a guess.
      expect(publicationCheck(`{"k":"${secret.slice(0, 6)}\\u005a${secret.slice(7)}"}`, [], { secrets: [secret] }).ok).toBe(false);
      expect(publicationCheck("short-value", [], { secrets: ["short-value"] }).blocked.map((b) => b.label)).toEqual(["known-secret"]);
      // Round 5 review: a known secret that ALSO matches a shape pattern must not be reported by that pattern,
      // whose sample carries the value's first 24 characters into thrown errors and redaction ledgers.
      const shaped = "sk-ant-123456789012345";
      const shapedVerdict = publicationCheck(`log ${shaped}`, [], { secrets: [shaped] });
      expect(shapedVerdict.blocked.map((b) => b.label)).toEqual(["known-secret"]);
      expect(JSON.stringify(shapedVerdict)).not.toContain(shaped.slice(0, 13));
      // And allowlisting it does not put it in fixtureDerived: `secrets` outranks `allowlist`.
      expect(publicationCheck(`log ${shaped}`, [shaped], { secrets: [shaped] }).fixtureDerived).toEqual([]);
    });
    it("environment secrets are selected by name suffix, at any length, and short ones are the operator's call", () => {
      expect(environmentSecrets({ CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(30), PATH: "y".repeat(50) })).toEqual(["x".repeat(30)]);
      // A short password is still a password: collected, and refused end to end by the value the collector found.
      const env = { SERVICE_PASSWORD: "hunter2-abcdefgh", PATH: "y".repeat(50) };
      expect(environmentSecrets(env)).toEqual(["hunter2-abcdefgh"]);
      expect(publicationCheck("log hunter2-abcdefgh here", [], { secrets: environmentSecrets(env) }).blocked.map((b) => b.label)).toEqual(["known-secret"]);
      // It is also ambiguous, so it is reported BY NAME for the operator to settle before a cell is spent.
      expect(ambiguousEnvironmentSecrets(env)).toEqual(["SERVICE_PASSWORD"]);
      expect(JSON.stringify(ambiguousEnvironmentSecrets(env))).not.toContain("hunter2");
      expect(ambiguousEnvironmentSecrets({ CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(30) })).toEqual([]);
    });
    it("a nested tool result stays parseable: an escaped quote is never eaten by a span", () => {
      const nested = JSON.stringify({ result: JSON.stringify({ p: "/tmp/foo bar" }) });
      const s = sanitize(nested, twinCtx);
      expect(publicationCheck(s.text, allow).ok).toBe(true);
      expect(jsonShapePreserved(nested, s.text)).toBe(true);
      expect(JSON.parse(JSON.parse(s.text).result as string)).toEqual({ p: "<ABS>" });
    });
    it("the shape guard catches a replacement that would break a document", () => {
      expect(jsonShapePreserved('{"a":1}', '{"a":1')).toBe(false);
      expect(jsonShapePreserved('{"a":1}\n{"b":2}', '{"a":1}\n{"b":2}')).toBe(true);
      expect(jsonShapePreserved("plain text", "plain <ABS>")).toBe(true);
    });
    it("a blob carrying every shape the smoke cell hit publishes cleanly", () => {
      const raw = JSON.stringify({
        cwd: "/private/var/folders/1l/xx/T/continuity-work-abc",
        cmd: "node /Users/someone/Developer/CPM/storybloq/dist/mcp.js",
        scratch: ["/tmp/t2.diff", "/tmp/JobQueue.orig.ts", "file:///var/folders/1l/xx/T/other"],
        who: "someone <noreply@anthropic.com>",
        fixture: "Bearer abc and sk-abcdefghijk stay",
        relative: "src/platform/logging/AppLogger.ts",
      });
      const s = sanitize(raw, { ...twinCtx, allowlist: allow });
      const v = publicationCheck(s.text, allow);
      expect(v.blocked).toEqual([]);
      expect(s.text).toContain("Bearer abc");
      expect(s.text).toContain("sk-abcdefghijk");
      expect(s.text).toContain("src/platform/logging/AppLogger.ts");
    });
  });
  it("the checked-in rubric and a generated scoring request publish cleanly (backticked /story auto is a command, not a path)", () => {
    const allow = fixtureCredentialAllowlist(join(FIXTURE, "core"));
    const rubric = readFileSync(join(FIXTURE, "rubric.md"), "utf-8");
    expect(publicationCheck(rubric, allow).blocked).toEqual([]);
    expect(publicationCheck("run `/story auto T-2` then `/story review T-2`", allow).ok).toBe(true);
    const d = join(tmp("cont-req-"), "attempt-001");
    writeAttempt(d, baseRecord({ task: "T-2.a" }), { "plan.md": "# plan\n\nRun `/story auto T-2`; read src/platform/logging/AppLogger.ts (Bearer abc appears in the test)\n" });
    const req = scoringRequest(d, rubric, readFileSync(join(FIXTURE, "fixture-map.json"), "utf-8"));
    expect(() => publishText(join(d, "scoring-request.rubric1.md"), req, allow)).not.toThrow();
  });
  it("catches file URLs, quoted paths with spaces, and Unicode path segments", () => {
    const allow: string[] = [];
    expect(publicationCheck("see file:///Volumes/private/client.csv", allow).blocked[0]!.sample).toBe("/Volumes/private/client.csv");
    expect(publicationCheck("see file:///Volumes/private/my%20client.csv", allow).blocked[0]!.sample).toBe("/Volumes/private/my client.csv");
    expect(publicationCheck('opened "/Private Drive/client.csv" today', allow).blocked[0]!.sample).toBe("/Private Drive/client.csv");
    expect(publicationCheck("read /Users/amélie/Dokumente/geheim.txt", allow).ok).toBe(false);
    expect(publicationCheck('opened "/dev/null" and file:///usr/bin/env', allow).ok).toBe(true);
  });
});

describe("hashing", () => {
  it("inventories symlinks so an extra symlinked skill file is visible and a retargeted link changes the hash", () => {
    const root = tmp("cont-link-");
    const src = join(root, "src"); const inst = join(root, "inst"); const elsewhere = join(root, "elsewhere");
    for (const d of [src, inst, elsewhere]) mkdirSync(d);
    writeFileSync(join(src, "SKILL.md"), "same"); writeFileSync(join(inst, "SKILL.md"), "same");
    writeFileSync(join(elsewhere, "a.md"), "A"); writeFileSync(join(elsewhere, "b.md"), "B");
    expect(skillPayloadDiff(inst, src).ok).toBe(true);
    symlinkSync(join(elsewhere, "a.md"), join(inst, "extra.md"));
    const d = skillPayloadDiff(inst, src);
    expect(d.ok).toBe(false);
    expect(d.extra).toEqual(["extra.md (symlink)"]);
    const h1 = hashTree(inst).sha256;
    rmSync(join(inst, "extra.md")); symlinkSync(join(elsewhere, "b.md"), join(inst, "extra.md"));
    expect(hashTree(inst).sha256).not.toBe(h1);
    expect(hashTree(inst).links).toEqual(["extra.md"]);
  });
  it("the installer's marker and a well-formed fingerprint sidecar are exempt; a malformed sidecar is an extra file", () => {
    const root = tmp("cont-fp-");
    const src = join(root, "src"); const inst = join(root, "inst");
    for (const d of [src, inst]) mkdirSync(d);
    writeFileSync(join(src, "SKILL.md"), "same"); writeFileSync(join(inst, "SKILL.md"), "same");
    writeFileSync(join(inst, ".storybloq-version"), "1.16.0\n");
    writeFileSync(join(inst, ".storybloq-skill-fingerprint"), `sha256:${"a".repeat(64)}\n`);
    const ok = skillPayloadDiff(inst, src);
    expect(ok).toEqual({ ok: true, extra: [], missing: [], changed: [], marker: "1.16.0" });
    writeFileSync(join(inst, ".storybloq-skill-fingerprint"), "sha256:not-a-digest\n");
    const bad = skillPayloadDiff(inst, src);
    expect(bad.ok).toBe(false);
    expect(bad.extra).toEqual([".storybloq-skill-fingerprint"]);
  });
  it("volatile names are skipped only directly under .story; a source directory named telemetry still counts", () => {
    const root = tmp("cont-vol-");
    mkdirSync(join(root, "src", "telemetry"), { recursive: true }); writeFileSync(join(root, "src", "telemetry", "x.ts"), "1");
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true }); writeFileSync(join(root, ".story", "telemetry", "p.json"), "{}");
    writeFileSync(join(root, ".story", "status.json"), "{}");
    expect(hashTree(root).files).toEqual(["src/telemetry/x.ts"]);
    const h = hashTree(root).sha256;
    writeFileSync(join(root, "src", "telemetry", "x.ts"), "2");
    expect(hashTree(root).sha256).not.toBe(h);
  });
  it("volatile .story entries are never copied into a working copy", () => {
    const src = tmp("cont-mat-src-");
    mkdirSync(join(src, "core", ".story", "tickets"), { recursive: true });
    writeFileSync(join(src, "core", ".story", "tickets", "T-2.json"), JSON.stringify({ id: "T-2", title: "t", description: "d" }));
    for (const d of ["sessions/abc", "telemetry/presence", "snapshots", "servers"]) mkdirSync(join(src, "core", ".story", d), { recursive: true });
    writeFileSync(join(src, "core", ".story", "sessions", "abc", "state.json"), "{}");
    writeFileSync(join(src, "core", ".story", "status.json"), "{}");
    mkdirSync(join(src, "variants")); writeFileSync(join(src, "variants", "T-2.a.json"), JSON.stringify({ title: "x", description: "y" }));
    const dest = tmp("cont-mat-dest-");
    materialize(src, 1, "T-2.a", dest);
    expect(existsSync(join(dest, ".story", "tickets", "T-2.json"))).toBe(true);
    for (const d of ["sessions", "telemetry", "snapshots", "servers", "status.json"]) expect(existsSync(join(dest, ".story", d))).toBe(false);
  });
  it("hashInputs is stable and sensitive to content", () => {
    const d = tmp("cont-hash-"); writeFileSync(join(d, "a.txt"), "1");
    const h1 = hashInputs([{ label: "x", path: d }]); writeFileSync(join(d, "a.txt"), "2");
    expect(hashInputs([{ label: "x", path: d }])).not.toBe(h1);
  });
  it("experiment hash changes on any stable input, including the configuration fingerprint, and the build manifest ignores HEAD", () => {
    const i = { arm: 1 as const, inputTreeHash: "t", buildManifestHash: "b", model: "m", effort: "high", timeoutMs: 1, maxBudgetUsd: 2, clientVersion: "c", isolation: "fresh" as const, configHash: "cfg", launchPolicy: LAUNCH_POLICY };
    expect(experimentHash(i)).toBe(experimentHash({ ...i }));
    for (const k of Object.keys(i) as (keyof typeof i)[]) expect(experimentHash({ ...i, [k]: k === "arm" ? 2 : k === "isolation" ? "shared" : typeof i[k] === "number" ? 99 : "x" })).not.toBe(experimentHash(i));
    const m = { workspaceHead: "a", nodeVersion: "v", packageJsonSha256: "1", lockfileSha256: "2", installedLockSha256: "3", tsupConfigSha256: "4", dist: {}, evalMcpSha256: "5", codexSha256: "6", codexVersion: "v", storybloqVersion: "1", storybloqExecutable: "e", claudeVersion: "c" };
    expect(buildManifestHash(m)).toBe(buildManifestHash({ ...m, workspaceHead: "b" }));
    expect(buildManifestHash(m)).not.toBe(buildManifestHash({ ...m, dist: { "dist/mcp.js": "x" } }));
    expect(buildManifestHash(m)).not.toBe(buildManifestHash({ ...m, evalMcpSha256: "6" }));
    // J2: a different codex, by bytes or by version, is a different build.
    expect(buildManifestHash(m)).not.toBe(buildManifestHash({ ...m, codexSha256: "7" }));
    expect(buildManifestHash(m)).not.toBe(buildManifestHash({ ...m, codexVersion: "w" }));
  });
});

describe("ledger snapshot diff", () => {
  it("reports added records with content, field-level changes, removals, and ignores volatile dirs", () => {
    const root = tmp("cont-ledger-");
    const b = join(root, "before"); const a = join(root, "after");
    for (const d of [b, a]) { mkdirSync(join(d, "tickets"), { recursive: true }); mkdirSync(join(d, "sessions", "x"), { recursive: true }); writeFileSync(join(d, "sessions", "x", "state.json"), d); }
    writeFileSync(join(b, "tickets", "T-2.json"), JSON.stringify({ id: "T-2", status: "open" }));
    writeFileSync(join(a, "tickets", "T-2.json"), JSON.stringify({ id: "T-2", status: "complete", citesRulings: ["r-1"] }));
    writeFileSync(join(b, "tickets", "T-9.json"), JSON.stringify({ id: "T-9" }));
    mkdirSync(join(a, "handovers")); writeFileSync(join(a, "handovers", "h.md"), "# h");
    expect(diffLedger(b, a)).toEqual([
      { path: "handovers/h.md", kind: "added", content: "# h" },
      { path: "tickets/T-2.json", kind: "changed", fields: { status: { before: "open", after: "complete" }, citesRulings: { before: undefined, after: ["r-1"] } } },
      { path: "tickets/T-9.json", kind: "removed", content: { id: "T-9" } },
    ]);
  });
});

describe("cells, retries, qualification", () => {
  const E = "exp";
  const CELL = { task: "T-4", repeat: 1 };
  const rec = (validity: "valid" | "invalid", exp = E, evidenceComplete = true, task = "T-4", repeat = 1) => ({ validity, experimentHash: exp, completed: true, evidenceComplete, task, repeat, launchPolicy: LAUNCH_POLICY });
  it("an empty cell runs attempt 1; attempt numbers continue across restarts", () => {
    expect(decideCell([], E, CELL)).toEqual({ kind: "run", nextAttempt: 1, mismatched: [] });
    expect(decideCell([{ name: "attempt-002", record: rec("invalid") }], E, CELL)).toEqual({ kind: "run", nextAttempt: 3, mismatched: [] });
  });
  it("one valid observation satisfies and carries its evidence status; a foreign experiment's record does not satisfy", () => {
    expect(decideCell([{ name: "attempt-001", record: rec("valid") }], E, CELL)).toEqual({ kind: "satisfied", attempt: "attempt-001", evidenceComplete: true });
    expect(decideCell([{ name: "attempt-001", record: rec("valid", E, false) }], E, CELL)).toEqual({ kind: "satisfied", attempt: "attempt-001", evidenceComplete: false });
    expect(decideCell([{ name: "attempt-001", record: rec("valid", "other") }], E, CELL)).toEqual({ kind: "run", nextAttempt: 2, mismatched: [] });
  });
  it("a record captured for another cell never satisfies this one, is reported, and keeps only its directory number", () => {
    const copied = [{ name: "attempt-001", record: rec("valid", E, true, "T-4", 2) }];
    expect(decideCell(copied, E, CELL)).toEqual({ kind: "run", nextAttempt: 2, mismatched: ["attempt-001 records T-4#2"] });
    const three = [1, 2, 3].map((n) => ({ name: `attempt-00${n}`, record: rec("invalid", E, true, "T-3", 1) }));
    expect(decideCell(three, E, CELL).kind).toBe("run");
  });
  it("every allocated attempt counts toward exhaustion, including crashes that left no record", () => {
    const invalids = Array.from({ length: MAX_INVALID_RETRIES + 1 }, (_, i) => ({ name: `attempt-00${i + 1}`, record: rec("invalid") }));
    expect(decideCell(invalids.slice(0, MAX_INVALID_RETRIES), E, CELL).kind).toBe("run");
    expect(decideCell(invalids, E, CELL)).toEqual({ kind: "exhausted", mismatched: [] });
    const crashes = Array.from({ length: MAX_INVALID_RETRIES + 1 }, (_, i) => ({ name: `attempt-00${i + 1}`, record: null }));
    expect(decideCell(crashes, E, CELL)).toEqual({ kind: "exhausted", mismatched: [] });
    expect(decideCell(crashes.slice(0, 1), E, CELL)).toEqual({ kind: "run", nextAttempt: 2, mismatched: [] });
  });
  it("B2: a rate-limited attempt never counts toward exhaustion; every other invalid reason still does", () => {
    const limited = Array.from({ length: MAX_INVALID_RETRIES + 2 }, (_, i) => ({ name: `attempt-00${i + 1}`, record: { ...rec("invalid"), invalidReasons: ["rate-limited"] } }));
    expect(decideCell(limited, E, CELL)).toEqual({ kind: "run", nextAttempt: MAX_INVALID_RETRIES + 3, mismatched: [] });
    const drifted = limited.map((a) => ({ ...a, record: { ...a.record, invalidReasons: ["config-drift"] } }));
    expect(decideCell(drifted, E, CELL)).toEqual({ kind: "exhausted", mismatched: [] });
    const loaded = limited.map((a) => ({ ...a, record: { ...a.record, invalidReasons: ["machine-load"] } }));
    expect(decideCell(loaded, E, CELL)).toEqual({ kind: "run", nextAttempt: MAX_INVALID_RETRIES + 3, mismatched: [] });
    // Mixed: the rate-limited attempts are skipped and the others still count, whatever their order.
    const at = (n: number, reason: string) => ({ name: `attempt-00${n}`, record: { ...rec("invalid"), invalidReasons: [reason] } });
    const mixedRun = [at(1, "rate-limited"), at(2, "config-drift"), at(3, "rate-limited"), at(4, "stream-corrupt")];
    expect(decideCell(mixedRun, E, CELL)).toEqual({ kind: "run", nextAttempt: 5, mismatched: [] });
    expect(decideCell([...mixedRun, at(5, "model-drift")], E, CELL)).toEqual({ kind: "exhausted", mismatched: [] });
    expect(decideCell([at(1, "config-drift"), at(2, "rate-limited"), at(3, "rate-limited"), at(4, "stream-corrupt"), at(5, "rate-limited")], E, CELL)).toEqual({ kind: "run", nextAttempt: 6, mismatched: [] });
  });
  it("qualifies only for exactly the preregistered cells, each satisfied with complete evidence, under a verified pilot; shared never qualifies", () => {
    const all = TASKS.flatMap((task) => Array.from({ length: REPEATS }, (_, i) => ({ task, repeat: i + 1, satisfied: true, evidenceComplete: true })));
    expect(expectedCellKeys()).toHaveLength(15);
    expect(qualifies({ cells: all, isolation: "fresh", pilot: PILOT_OK }).qualifying).toBe(true);
    expect(qualifies({ cells: all, isolation: "shared", pilot: PILOT_OK })).toMatchObject({ qualifying: false, reason: "shared isolation is refused (ISS-1486)" });
    expect(qualifies({ cells: all, isolation: "fresh", pilot: { ok: false, reason: "the pilot failed (network)" } })).toMatchObject({ qualifying: false, reason: "no verified pilot: the pilot failed (network)" });
    const dup = Array.from({ length: 15 }, () => ({ task: "T-2.a", repeat: 1, satisfied: true, evidenceComplete: true }));
    expect(qualifies({ cells: dup, isolation: "fresh", pilot: PILOT_OK }).reason).toMatch(/duplicate cells/);
    const q = qualifies({ cells: all.map((c, i) => (i === 7 ? { ...c, satisfied: false } : c)), isolation: "fresh", pilot: PILOT_OK });
    expect(q.qualifying).toBe(false); expect(q.shortCells).toEqual(["T-2.c#2"]);
    const short = qualifies({ cells: all.slice(0, 14), isolation: "fresh", pilot: PILOT_OK });
    expect(short.qualifying).toBe(false); expect(short.reason).toBe("missing cells: T-4#3");
    expect(qualifies({ cells: [...all.slice(0, 14), { task: "T-4", repeat: 4, satisfied: true, evidenceComplete: true }], isolation: "fresh", pilot: PILOT_OK }).reason).toMatch(/unknown cells: T-4#4/);
    const unpub = qualifies({ cells: all.map((c, i) => (i === 3 ? { ...c, evidenceComplete: false } : c)), isolation: "fresh", pilot: PILOT_OK });
    expect(unpub.qualifying).toBe(false); expect(unpub.unpublishedCells).toEqual(["T-2.b#1"]);
  });
  it("the shared verifier trusts nothing from record.json alone: record hash, manifest schema, required artefacts, artefact bytes", () => {
    const cell = tmp("cont-cell-");
    const good = baseRecord({ experimentHash: E, requiredArtefacts: ["evidence.jsonl"] });
    writeAttempt(join(cell, "attempt-001"), good, { "evidence.jsonl": "e" });
    expect(verifyAttemptDir(join(cell, "attempt-001"))).toMatchObject({ evidenceComplete: true, reason: null });
    // Tampered record (validity flipped) no longer hashes as listed: the attempt has no trusted record at all.
    writeAttempt(join(cell, "attempt-002"), good, { "evidence.jsonl": "e" });
    writeFileSync(join(cell, "attempt-002", "record.json"), JSON.stringify({ ...good, validity: "invalid" }));
    expect(verifyAttemptDir(join(cell, "attempt-002"))).toMatchObject({ record: null, reason: "record.json does not hash as listed" });
    // A required artefact absent from the manifest is incomplete evidence even with an otherwise empty manifest.
    writeAttempt(join(cell, "attempt-003"), baseRecord({ experimentHash: E, requiredArtefacts: ["evidence.jsonl", "plan.md"] }), { "evidence.jsonl": "e" });
    expect(verifyAttemptDir(join(cell, "attempt-003"))).toMatchObject({ evidenceComplete: false, reason: "required artefact plan.md not in manifest" });
    // A changed artefact.
    writeAttempt(join(cell, "attempt-004"), good, { "evidence.jsonl": "e" });
    writeFileSync(join(cell, "attempt-004", "evidence.jsonl"), "tampered");
    expect(verifyAttemptDir(join(cell, "attempt-004"))).toMatchObject({ evidenceComplete: false, reason: "artefact evidence.jsonl missing or changed" });
    // No completed marker, off-schema manifest, off-schema record.
    mkdirSync(join(cell, "attempt-005")); writeFileSync(join(cell, "attempt-005", "record.json"), JSON.stringify(good));
    expect(verifyAttemptDir(join(cell, "attempt-005")).reason).toBe("no completed record");
    writeAttempt(join(cell, "attempt-006"), good, {}); writeFileSync(join(cell, "attempt-006", "artefacts.sha256.json"), JSON.stringify({ "record.json": "short" }));
    expect(verifyAttemptDir(join(cell, "attempt-006")).reason).toBe("artefact manifest off-schema");
    const offSchema = { ...good } as Record<string, unknown>; delete offSchema.requiredArtefacts;
    writeAttempt(join(cell, "attempt-007"), offSchema, {});
    expect(verifyAttemptDir(join(cell, "attempt-007")).reason).toBe("record schema");
    const a = Object.fromEntries(readAttempts(cell).map((x) => [x.name, x]));
    expect(a["attempt-001"]!.record?.evidenceComplete).toBe(true);
    expect(a["attempt-002"]!.record).toBeNull();
    expect(a["attempt-003"]!.record?.evidenceComplete).toBe(false);
    expect(a["attempt-004"]!.record?.evidenceComplete).toBe(false);
    expect(decideCell(readAttempts(cell), E, { task: "T-4", repeat: 1 }).kind).toBe("satisfied");
  });
});

describe("dispatcher arguments, CLI and preflight helpers", () => {
  it("ISS-1486: shared isolation and an owner exception are refused at the command line and at every entry point, before any spawn", async () => {
    const out = tmp("cont-out-"); const raw = tmp("cont-raw-");
    expect(() => parseArgs(["--isolation", "shared", "--out", out, "--raw-out", raw])).toThrow(SHARED_REFUSAL);
    expect(() => parseArgs(["--owner-exception", "r-aaaaaaaaaaaaaaaa", "--out", out, "--raw-out", raw])).toThrow(SHARED_REFUSAL);
    expect(parseArgs(["--out", out, "--raw-out", raw]).isolation).toBe("fresh");
    expect(() => refuseShared({ isolation: "shared" })).toThrow(SHARED_REFUSAL);
    expect(() => refuseShared({ isolation: "fresh", ownerException: "r-aaaaaaaaaaaaaaaa" })).toThrow(SHARED_REFUSAL);
    expect(() => refuseShared({ isolation: "fresh", ownerException: null })).not.toThrow();
    const o = options({ isolation: "shared" }); const pf = fakePreflight(); let spawned = 0;
    const spawnFn: SpawnFn = () => { spawned++; throw new Error("spawned"); };
    await expect(runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn }))).rejects.toThrow(SHARED_REFUSAL);
    await expect(runMatrix(o, pf, deps({ spawnFn }))).rejects.toThrow(SHARED_REFUSAL);
    expect(spawned).toBe(0);
  });
  it("T-525: signed-in is refused at every execution entry point and at the driveClaude spawn boundary, with a supplied Preflight", async () => {
    // Token-shaped names in this process's env would be named first; take them out for the row, values untouched.
    const { signedInEnvProblems, SIGNED_IN_MISSING_GATES } = await import("../../scripts/continuity-signed-in.js");
    const saved: Record<string, string | undefined> = {};
    for (const k of signedInEnvProblems(process.env)) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const o = options({ isolation: "signed-in", liveAck: "r-hs5j319qkr3gjvtz" }); const pf = fakePreflight(); let spawned = 0;
      const spawnFn: SpawnFn = () => { spawned++; throw new Error("spawned"); };
      const gates = SIGNED_IN_MISSING_GATES[0]; // toThrow(string) matches a substring of the message
      await expect(runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn }))).rejects.toThrow(gates);
      await expect(runPilot(o, pf, deps({ spawnFn }))).rejects.toThrow(gates);
      await expect(runMatrix(o, pf, deps({ spawnFn }))).rejects.toThrow(gates);
      const dir = tmp("cont-drive-");
      await expect(driveClaude(o, {} as Launch, "p", { transcript: join(dir, "t"), stderr: join(dir, "e") }, deps({ spawnFn }), () => {})).rejects.toThrow(gates);
      expect(spawned).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
  it("parses and validates options; skip-build and duplicate tasks are refused", () => {
    const out = tmp("cont-out-"); const raw = tmp("cont-raw-");
    const o = parseArgs(["--arm", "1", "--tasks", "T-2.c,T-4", "--isolation", "fresh", "--timeout-ms", "1000", "--out", out, "--raw-out", raw]);
    expect(o.tasks).toEqual(["T-2.c", "T-4"]); expect(o.isolation).toBe("fresh"); expect(o.repeats).toBe(3);
    expect(() => parseArgs(["--tasks", "T-9", "--out", out, "--raw-out", raw])).toThrow(/unknown task/);
    expect(() => parseArgs(["--tasks", "T-4,T-4", "--out", out, "--raw-out", raw])).toThrow(/twice/);
    expect(() => parseArgs(["--isolation", "loose", "--out", out, "--raw-out", raw])).toThrow(/is refused/);
    expect(() => parseArgs(["--timeout-ms", "0", "--out", out, "--raw-out", raw])).toThrow(/positive integer/);
    expect(() => parseArgs(["--skip-build", "--out", out, "--raw-out", raw])).toThrow(/not supported/);
    expect(() => parseArgs(["--repeats", "4", "--out", out, "--raw-out", raw])).toThrow(/repeats/);
    expect(INPUT_PATHS).not.toContain("test/fixtures/continuity/baseline");
  });
  it("refuses a raw directory inside the package, equal to, nested in, or symlinked into the public output", () => {
    const root = tmp("cont-paths-");
    const pkg = join(root, "pkg"); mkdirSync(join(pkg, "test"), { recursive: true });
    const out = join(root, "out"); const raw = join(root, "raw");
    expect(() => checkOutputPaths(out, raw, pkg)).not.toThrow();
    expect(() => checkOutputPaths(out, join(pkg, "test", "raw"), pkg)).toThrow(/inside the package/);
    expect(() => checkOutputPaths(out, out, pkg)).toThrow(/overlap/);
    expect(() => checkOutputPaths(out, join(out, "raw"), pkg)).toThrow(/overlap/);
    expect(() => checkOutputPaths(join(raw, "pub"), raw, pkg)).toThrow(/overlap/);
    symlinkSync(pkg, join(root, "link-to-pkg"));
    expect(() => checkOutputPaths(out, join(root, "link-to-pkg", "eval"), pkg)).toThrow(/inside the package/);
    mkdirSync(out); symlinkSync(out, join(root, "link-to-out"));
    expect(() => checkOutputPaths(out, join(root, "link-to-out", "raw"), pkg)).toThrow(/overlap/);
  });
  it("the effective configuration inventories quoted hook paths, the user CLAUDE.md, the plugin inventory and the skill tree", () => {
    const cfg = tmp("cont-cfg-");
    const hook = join(cfg, "my hook.sh"); writeFileSync(hook, "#!/bin/sh\necho 1\n");
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: `bash "${hook}" --flag` }] }] } }));
    expect(commandTokens(`bash "${hook}" --flag 'a b'`)).toEqual(["bash", hook, "--flag", "a b"]);
    const h1 = effectiveConfigHash(cfg);
    expect(Object.keys(h1.inventory)).toContain(`hook:${hook}`);
    writeFileSync(hook, "#!/bin/sh\necho 2\n");
    expect(effectiveConfigHash(cfg).sha256).not.toBe(h1.sha256);
    const h2 = effectiveConfigHash(cfg).sha256;
    mkdirSync(join(cfg, "plugins")); writeFileSync(join(cfg, "plugins", "installed_plugins.json"), "{}");
    expect(effectiveConfigHash(cfg).sha256).not.toBe(h2);
    const h3 = effectiveConfigHash(cfg).sha256;
    writeFileSync(join(cfg, "CLAUDE.md"), "be terse");
    expect(effectiveConfigHash(cfg).sha256).not.toBe(h3);
    const a = tmp("cont-fresh-a-"); const b = tmp("cont-fresh-b-");
    provisionFreshConfig(a); provisionFreshConfig(b);
    expect(effectiveConfigHash(a).sha256).toBe(effectiveConfigHash(b).sha256);
  });
  it("ISS-1315: plugin inventories hash without the timestamps the client rewrites, and keep what a plugin is", () => {
    const market = (repo: string, stamp: string): string => JSON.stringify({ official: { source: { source: "github", repo }, installLocation: "/x/official", lastUpdated: stamp } });
    const cfg = tmp("cont-plug-"); mkdirSync(join(cfg, "plugins"));
    const mk = join(cfg, "plugins", "known_marketplaces.json");
    writeFileSync(mk, market("a/official", "2026-09-26T05:00:00.000Z"));
    const h1 = effectiveConfigHash(cfg);
    writeFileSync(mk, market("a/official", "2026-09-26T17:02:11.693Z"));
    expect(effectiveConfigHash(cfg).sha256).toBe(h1.sha256);
    writeFileSync(mk, market("b/official", "2026-09-26T05:00:00.000Z"));
    expect(effectiveConfigHash(cfg).sha256).not.toBe(h1.sha256);
    // Any depth, both keys, key order irrelevant.
    const installed = (at: string, version: string) => JSON.stringify({ version: 2, plugins: { "p@m": [{ version, installedAt: at, lastUpdated: at, scope: "user" }] } });
    expect(pluginInventoryHash(installed("2026-01-01", "1.0.0"))).toEqual(pluginInventoryHash(installed("2026-09-26", "1.0.0")));
    expect(pluginInventoryHash(installed("2026-01-01", "1.0.0")).sha256).not.toBe(pluginInventoryHash(installed("2026-01-01", "1.0.1")).sha256);
    expect(pluginInventoryHash('{"b":1,"a":2}').sha256).toBe(pluginInventoryHash('{"a":2,"b":1}').sha256);
    // A "__proto__" key is data like any other: a change under it moves the hash, at the top and nested.
    expect(pluginInventoryHash('{"__proto__":{"v":"1.0.0"}}').sha256).not.toBe(pluginInventoryHash('{"__proto__":{"v":"1.0.1"}}').sha256);
    expect(pluginInventoryHash('{"p":{"__proto__":1}}').sha256).not.toBe(pluginInventoryHash('{"p":{}}').sha256);
    // Unparseable text still hashes (raw), and the inventory says so, as settings.json does.
    writeFileSync(mk, "{ not json");
    const bad = effectiveConfigHash(cfg);
    expect(bad.inventory["plugins/known_marketplaces.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(bad.inventory["plugins/known_marketplaces.json:parse"]).toBe("invalid-json");
    expect(h1.inventory["plugins/known_marketplaces.json:parse"]).toBeUndefined();
    writeFileSync(mk, "{ not json!");
    expect(effectiveConfigHash(cfg).sha256).not.toBe(bad.sha256);
  });
});

// --- attempt and matrix lifecycle with a fake child process ------------------------------------

class FakeChild extends EventEmitter {
  pid = 999999;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: string[] = [];
  constructor(private readonly ignoreTerm: boolean) { super(); }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(sig);
    if (sig === "SIGTERM" && this.ignoreTerm) return true;
    this.finish(null, sig);
    return true;
  }
  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.stdout.end();
    this.stdin.destroy();
    setTimeout(() => this.emit("close", code, signal), 0);
  }
}

interface FakeBehaviour {
  readonly hang?: boolean;
  readonly ignoreTerm?: boolean;
  readonly complete?: boolean;
  readonly noPlanFile?: boolean;
  readonly handoverText?: string | ((ticketId: string) => string | undefined);
  readonly stateExtra?: Record<string, unknown>;
  /** Stream lines written after the standard ones (B2: a rate-limit stop). */
  readonly tail?: readonly string[];
  /** ISS-1486: one readback answer changed before it is sent. */
  readonly mutate?: (answers: Record<string, Record<string, unknown>>) => void;
}

/** Deterministic dist hashes: the lifecycle tests never need a build. */
const FAKE_DIST: Record<string, string> = { "dist/mcp.js": "1".repeat(64), "dist/cli.js": "2".repeat(64), "dist/index.js": "3".repeat(64), "dist/presence.js": "4".repeat(64) };
const fakeDist = (): Record<string, string> => ({ ...FAKE_DIST });
/** The five task-material labels (ISS-1273), spelled out so a wrong TASK_MATERIAL cannot agree with itself. */
const TM_LABELS = ["test/fixtures/continuity/core", "test/fixtures/continuity/variants", "test/fixtures/continuity/facts.json", "test/fixtures/continuity/fixture-map.json", "test/fixtures/continuity/rubric.md"];
/** Deterministic per-path input hashes: the lifecycle tests never rehash the real source tree. */
const FAKE_INPUTS: Record<string, string> = Object.fromEntries(INPUT_PATHS.map((p, i) => [p, String(i % 10).repeat(64)]));
const fakeInputs = (): { hashes: Record<string, string>; errors: Record<string, string> } => ({ hashes: { ...FAKE_INPUTS }, errors: {} });

const sentinel = createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: Record<string, unknown>) => Record<string, Record<string, unknown>> };

/**
 * ISS-1486: the client's side of the launch, in process. It reads the policy and MCP files the argv names, answers
 * the six readback requests with the measured shapes (Agent advertised, the server's environment echoed), and hands
 * the user message's text to `onPrompt`. `mutate` changes one answer before it is sent.
 */
function speakLaunch(child: FakeChild, args: readonly string[], cwd: string, onPrompt: (prompt: string) => void, mutate?: (answers: Record<string, Record<string, unknown>>) => void): void {
  const opt = (k: string): string => args[args.indexOf(k) + 1] ?? "";
  const policy = JSON.parse(readFileSync(opt("--settings"), "utf-8")) as { sandbox: { filesystem: { allowWrite: string[] } } };
  const server = (JSON.parse(readFileSync(opt("--mcp-config"), "utf-8")) as { mcpServers: { storybloq: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.storybloq;
  const answers = sentinel.goodResponses({ project: cwd, roots: policy.sandbox.filesystem.allowWrite, policy, mcpTools: TOOLS, mcpLaunch: { command: server.command, args: server.args } });
  for (const s of (answers.mcp_status!.mcpServers as { config: Record<string, unknown> }[])) s.config = { ...s.config, env: { ...server.env } };
  mutate?.(answers);
  let pending = "";
  child.stdin.on("data", (c: Buffer) => {
    pending += c.toString("utf-8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const text = pending.slice(0, nl); pending = pending.slice(nl + 1);
      if (text.trim() === "") continue;
      const msg = JSON.parse(text) as { type: string; request_id?: string; request?: { subtype: string }; message?: { content: unknown } };
      if (msg.type === "control_request") child.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[msg.request!.subtype] } })}\n`);
      else if (msg.type === "user") {
        const c = msg.message?.content;
        onPrompt(typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? "").join("") : "");
      }
    }
  });
}

function fakeSpawn(behaviour: FakeBehaviour, seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[]): SpawnFn {
  return (_cmd, args, options) => {
    const cwd = options.cwd as string;
    const env = options.env as NodeJS.ProcessEnv;
    const child = new FakeChild(behaviour.ignoreTerm === true);
    seen.push({ cwd, env, child });
    speakLaunch(child, args, cwd, (prompt) => {
      const ticketId = /^\/story auto (T-\d+)$/.exec(prompt)?.[1] ?? "T-0";
      const sessionDir = join(cwd, ".story", "sessions", SID);
      mkdirSync(sessionDir, { recursive: true });
      if (!behaviour.noPlanFile) writeFileSync(join(sessionDir, "plan.md"), "# plan\n\nEXISTING: src/http/router.ts\n");
      writeFileSync(join(sessionDir, "context-digest.md"), "# digest\n");
      const state: Record<string, unknown> = { state: "IMPLEMENT", status: "active", binaryFingerprint: { mtime: 1, sha256: FAKE_DIST["dist/mcp.js"] }, completedTickets: [], ...behaviour.stateExtra };
      if (behaviour.complete) {
        Object.assign(state, { state: "SESSION_END", status: "completed", terminationReason: "normal", completedTickets: [{ id: ticketId }] });
        const ticket = join(cwd, ".story", "tickets", `${ticketId}.json`);
        writeFileSync(ticket, JSON.stringify({ ...JSON.parse(readFileSync(ticket, "utf-8")), status: "complete" }, null, 2));
        mkdirSync(join(cwd, ".story", "handovers"), { recursive: true });
        const handover = typeof behaviour.handoverText === "function" ? behaviour.handoverText(ticketId) : behaviour.handoverText;
        writeFileSync(join(cwd, ".story", "handovers", `2026-09-20-${ticketId.toLowerCase()}.md`), handover ?? `# handover\n\n${ticketId} done; knowledgeImpact: new fact recorded\n`);
        const g = (a: string[]): void => { execFileSync("git", a, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); };
        g(["add", "-A"]); g(["commit", "-q", "-m", `${ticketId}: done`]);
      }
      writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state));
      const lines = [
        POLICY_INIT,
        assistant("r1", [{ type: "tool_use", id: "t1", name: guide, input: { sessionId: null, action: "start", targetWork: [ticketId] } }], u(10, 0, 100)),
        toolResult("t1", stateLine("PLAN")),
        assistant("r2", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: `${cwd}/src/http/router.ts` } }], u(10, 0, 200)),
        toolResult("t2", "export class Router {}"),
        assistant("r3", [{ type: "tool_use", id: "t3", name: guide, input: { sessionId: SID, action: "report", report: { completedAction: "plan_written" } } }], u(10, 0, 300)),
        toolResult("t3", stateLine("PLAN_REVIEW")),
      ];
      if (behaviour.complete) lines.push(ev("result", { subtype: "success", total_cost_usd: 0.5, num_turns: 4, usage: {}, permission_denials: [] }));
      lines.push(...(behaviour.tail ?? []));
      setTimeout(() => {
        for (const l of lines) child.stdout.write(`${l}\n`);
        if (!behaviour.hang) child.finish(0, null);
      }, 5);
    }, behaviour.mutate);
    return child as unknown as ChildProcess;
  };
}

/** J2: a codex that only answers --version: the fake client never starts the server, so nothing else runs it. */
const CODEX_VERSION_ONLY = ((): string => {
  const f = join(mkdtempSync(join(tmpdir(), "cont-codex-")), "codex");
  writeFileSync(f, "#!/bin/sh\necho codex-cli 0.0.0-version-only\n", { mode: 0o755 });
  return f;
})();

function fakePreflight(over: Partial<Preflight> = {}): Preflight {
  const dist = fakeDist();
  const template = tmp("cont-template-"); provisionFreshConfig(template);
  const cfg = effectiveConfigHash(template);
  return {
    build: { workspaceHead: "h", nodeVersion: process.version, packageJsonSha256: "p", lockfileSha256: "l", installedLockSha256: null, tsupConfigSha256: "t", dist, evalMcpSha256: existsSync(EVAL_MCP_BUNDLE) ? sha256(readFileSync(EVAL_MCP_BUNDLE)) : "bundle-missing", ...codexFingerprint(CODEX_VERSION_ONLY), storybloqVersion: "1.15.9", storybloqExecutable: join(PKG, "dist", "cli.js"), claudeVersion: "2.1.278 (Claude Code)" },
    // distHashes is injected per call (see deps()); the manifest carries the same synthetic values.
    buildManifestHash: "bmh", inputTreeHash: "ith", experiment: "e".repeat(64), isolation: "fresh", sharedConfigDir: null, configHash: cfg.sha256, configInventory: cfg.inventory,
    inputHashes: { ...FAKE_INPUTS }, taskMaterialHash: "a".repeat(64), taskMaterialHashes: Object.fromEntries(TM_LABELS.map((l) => [l, "b".repeat(64)])),
    // The client here is a fake, so the server's wrapper is never run; the launch needs only a codex that answers --version (J2).
    skillMarker: null, allowlist: fixtureCredentialAllowlist(join(FIXTURE, "core")), tools: TOOLS, codexBin: CODEX_VERSION_ONLY, ...over,
  };
}

function options(over: Partial<RunOptions> = {}): RunOptions {
  const o: RunOptions = { arm: 1, tasks: ["T-4"], repeats: 1, model: "claude-opus-5", effort: "high", isolation: "fresh", out: tmp("cont-out-"), rawOut: tmp("cont-raw-"), timeoutMs: 5000, sigkillGraceMs: 200, maxBudgetUsd: 1, ...over };
  // ISS-1486 D9: every run needs the arm's verified pilot beside the attempts; the lifecycle tests are not about it.
  writePilot(join(o.out, "e".repeat(12)), "e".repeat(64), o.arm);
  return o;
}

/** Every lifecycle call goes through here so no test depends on a built dist/. */
type LoadDeps = { loadSample?: () => { load1: number | null; swapFreeBytes: number | null }; loadSampleMs?: number; now?: () => number; provision?: (dest: string) => void; readbackTimeoutMs?: number };
const deps = (extra: { spawnFn: SpawnFn; signals?: EventEmitter; log?: (line: string) => void } & LoadDeps): { spawnFn: SpawnFn; signals?: EventEmitter; distHashes: () => Record<string, string>; inputHashes: typeof fakeInputs } & LoadDeps =>
  ({ loadSample: () => ({ load1: 1, swapFreeBytes: 8 * 1024 ** 3 }), ...extra, distHashes: fakeDist, inputHashes: fakeInputs });
/** A clock that advances a minute per reading, so a few real milliseconds of sampling span the rule's five minutes. */
const minuteClock = (): (() => number) => { let t = 0; return () => (t += 60_000); };

const pubDirOf = (o: RunOptions, pf: Preflight, task = "T-4", repeat = 1, attempt = "attempt-001"): string => join(o.out, pf.experiment.slice(0, 12), task, `repeat-${repeat}`, attempt);
const rawDirOf = (o: RunOptions, pf: Preflight, task = "T-4", repeat = 1, attempt = "attempt-001"): string => join(o.rawOut, pf.experiment.slice(0, 12), task, `repeat-${repeat}`, attempt);

describe("attempt lifecycle (fake child process, no model)", () => {
  it("a completed session is valid, completed, evidence-complete, and every published byte is sanitised", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(r).toEqual({ validity: "valid", completion: "completed", interrupted: false, rateLimited: false, machineLoad: false, evidenceComplete: true, inputDrift: { invalidating: [], disclosed: [], errors: {} }, configDrift: null, invalidReasons: [], wallMs: expect.any(Number), exitCode: 0, launchPolicy: null, inputFailure: null });
    const pub = pubDirOf(o, pf); const raw = rawDirOf(o, pf);
    for (const f of ["record.json", "completed", "artefacts.sha256.json", "load.json", "evidence.jsonl", "plan.initial.md", "plan.md", "plan-context.md", "manifest.json", "usage.json", "redaction.json", "task.json", "handover.md", "ledger.changes.json"]) expect(existsSync(join(pub, f)), f).toBe(true);
    expect(existsSync(join(raw, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(raw, "plans", "plan.initial.md"))).toBe(true);
    const workdir = seen[0]!.cwd;
    for (const f of readdirSync(pub)) {
      const text = readFileSync(join(pub, f), "utf-8");
      expect(text, f).not.toContain(workdir);
      expect(text, f).not.toContain(PKG);
      expect(publicationCheck(text, pf.allowlist).ok, f).toBe(true);
    }
    const record = JSON.parse(readFileSync(join(pub, "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.killKind).toBeNull(); expect(record.headAfter).not.toBe(record.headBefore);
    expect(JSON.parse(readFileSync(join(pub, "manifest.json"), "utf-8")).configHashBefore).toBe(pf.configHash);
    expect(readFileSync(join(pub, "evidence.jsonl"), "utf-8")).toContain("<WORKDIR>/src/http/router.ts");
    expect(seen[0]!.env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(existsSync(seen[0]!.env.CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  it("a timeout escalates SIGTERM then SIGKILL and is a valid behavioural failure, never an interruption", async () => {
    const o = options({ timeoutMs: 80, sigkillGraceMs: 40 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ hang: true, ignoreTerm: true }, seen) }));
    expect(seen[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r.interrupted).toBe(false);
    expect(r.validity).toBe("valid");
    expect(r.completion).toBe("incomplete");
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.killKind).toBe("timeout");
    expect(record.invalidReasons).toEqual([]);
  });

  it("ISS-1494: the group signal fails, the leader exits, the group answers alive then EPERM; after driveClaude returns, its handle probes no more", async () => {
    const saved = { ...processGroupSeams };
    let probes = 0;
    try {
      processGroupSeams.send = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
      processGroupSeams.leader = () => {};
      processGroupSeams.probe = () => { if (++probes > 2) throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
      const o = options({ timeoutMs: 80, sigkillGraceMs: 40 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
      const spawnFn = fakeSpawn({ hang: true, ignoreTerm: true }, seen);
      // The fake reports only close; a real child reports its exit first, which is what arms the handle's gone-watch.
      await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: (c, a, opt) => { const ch = spawnFn(c, a, opt); ch.on("close", (code: number | null, sig: NodeJS.Signals | null) => ch.emit("exit", code, sig)); return ch; } }));
      expect(seen[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      const first = probes;
      await new Promise((r) => setTimeout(r, 150));
      expect(probes).toBe(first);
    } finally {
      Object.assign(processGroupSeams, saved);
    }
  });

  it("an operator signal escalates, marks the attempt interrupted, and stops the matrix before any further spawn", async () => {
    const o = options({ tasks: ["T-4", "T-3"], repeats: 1, sigkillGraceMs: 40 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const signals = new EventEmitter();
    const spawnFn = fakeSpawn({ hang: true, ignoreTerm: true }, seen);
    const run = runMatrix(o, pf, deps({ spawnFn: (c, a, opt) => { const ch = spawnFn(c, a, opt); setTimeout(() => signals.emit("SIGINT"), 30); return ch; }, signals }));
    await expect(run).rejects.toBeInstanceOf(SessionKilledError);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.interrupted).toBe(true); expect(record.killKind).toBe("runner-signal"); expect(record.invalidReasons).toContain("interrupted");
    const exp = JSON.parse(readFileSync(join(o.out, pf.experiment.slice(0, 12), "experiment.json"), "utf-8")) as { qualification: { reason: string } };
    expect(exp.qualification.reason).toBe("interrupted by the operator");
    expect(existsSync(join(o.out, pf.experiment.slice(0, 12), "QUALIFYING"))).toBe(false);
    expect(existsSync(join(o.out, pf.experiment.slice(0, 12), "T-3"))).toBe(false);
  });

  it("B2: a timeout spent on a rate limit is invalid (rate-limited), never a behavioural failure", async () => {
    const o = options({ timeoutMs: 80, sigkillGraceMs: 40 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const tail = [ev("rate_limit_event", { rate_limit_info: { status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected" } })];
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ hang: true, ignoreTerm: true, tail }, seen) }));
    expect(r.validity).toBe("invalid"); expect(r.rateLimited).toBe(true); expect(r.interrupted).toBe(false);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.killKind).toBe("timeout");
    expect(record.invalidReasons).toEqual(["rate-limited"]);
    expect(record.rateLimitStop).toBe("rate_limit_event rejected (five_hour)");
  });

  it("B2: a rate-limit stop stops the matrix before any further spawn; the re-run resumes the cell without counting it", async () => {
    const o = options({ tasks: ["T-4", "T-3"], repeats: 1 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const tail = [ev("result", { subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429", num_turns: 3 })];
    await expect(runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ tail }, seen) }))).rejects.toBeInstanceOf(RateLimitStopError);
    expect(seen).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.validity).toBe("invalid"); expect(record.invalidReasons).toEqual(["rate-limited"]); expect(record.rateLimitStop).toBe("result api_error_status 429");
    const expDir = join(o.out, pf.experiment.slice(0, 12));
    const exp = JSON.parse(readFileSync(join(expDir, "experiment.json"), "utf-8")) as { qualification: { reason: string } };
    expect(exp.qualification.reason).toBe("stopped on a rate limit or overload; re-run the same command after it clears");
    expect(existsSync(join(expDir, "QUALIFYING"))).toBe(false);
    expect(existsSync(join(expDir, "T-3"))).toBe(false);
    expect(readAttempts(join(expDir, "T-4", "repeat-1"))[0]!.record!.invalidReasons).toEqual(["rate-limited"]);
    const again: typeof seen = [];
    const r = await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, again) }));
    expect(again).toHaveLength(2);
    expect(r.summary).toContain("T-4#1: satisfied by attempt-002");
  });

  it("ISS-1315 under ISS-1486: a fresh config that differs from preflight's spawns nothing, costs no attempt, names the files, exits the matrix, and resumes once restored", async () => {
    let drift = true;
    // D4: fresh provisioning writes no plugin inventory; any inventory file that appears is drift, named.
    const provision = (dest: string): void => {
      provisionFreshConfig(dest);
      if (!drift) return;
      mkdirSync(join(dest, "plugins")); writeFileSync(join(dest, "plugins", "known_marketplaces.json"), JSON.stringify({ m: { source: { repo: "b/m" }, lastUpdated: "t1" } }));
      writeFileSync(join(dest, "CLAUDE.md"), "drifted");
    };
    const o = options({ tasks: ["T-4", "T-3"] });
    const pf = fakePreflight();
    const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = []; const lines: string[] = [];
    const err = await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen), log: (l) => lines.push(l), provision })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigDriftStopError);
    expect((err as Error).message).toContain("config drifted since preflight (CLAUDE.md, plugins/known_marketplaces.json)");
    expect(seen).toHaveLength(0);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record).toMatchObject({ validity: "invalid", invalidReasons: ["config-drift"], completion: "not-started", configDrift: ["CLAUDE.md", "plugins/known_marketplaces.json"], wallMs: 0 });
    expect(lines).toEqual(["attempt T-4#1.1 invalid [config-drift] wall=0 exit=none"]);
    const expDir = join(o.out, pf.experiment.slice(0, 12));
    expect(readAttempts(join(expDir, "T-4", "repeat-1"))[0]!.record).toMatchObject({ completion: "not-started", invalidReasons: ["config-drift"] });
    expect(existsSync(join(expDir, "T-3"))).toBe(false);
    // Restored: the refusal is not counted, so the cell resumes at attempt-002 with its full retry budget.
    drift = false;
    const again: typeof seen = [];
    const r = await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, again), log: () => {}, provision }));
    expect(again).toHaveLength(2);
    expect(r.summary).toContain("T-4#1: satisfied by attempt-002");
  });
  it("ISS-1315: a not-started refusal never counts toward the retry budget", () => {
    const rec = (n: number, extra: Record<string, unknown> = {}) => ({ name: `attempt-00${n}`, record: { validity: "invalid" as const, experimentHash: "e", completed: true, evidenceComplete: false, task: "T-4", repeat: 1, invalidReasons: ["config-drift"], ...extra } });
    const refused = [1, 2, 3, 4, 5, 6].map((n) => rec(n, { completion: "not-started" }));
    expect(decideCell(refused, "e", { task: "T-4", repeat: 1 })).toEqual({ kind: "run", nextAttempt: 7, mismatched: [] });
    expect(decideCell([1, 2, 3, 4, 5, 6].map((n) => rec(n, { completion: "completed" })), "e", { task: "T-4", repeat: 1 }).kind).toBe("exhausted");
  });

  it("every attempt prints one progress line: cell, attempt, validity, reasons, wall seconds, exit code", async () => {
    const o = options({ repeats: 2 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = []; const lines: string[] = [];
    await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen), log: (l) => lines.push(l) }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^attempt T-4#1\.1 valid \[\] wall=\d+ exit=0$/);
    expect(lines[1]).toMatch(/^attempt T-4#2\.1 valid \[\] wall=\d+ exit=0$/);
  });

  it("a timeout under sustained measured load is invalid (machine-load), not counted, and stops the matrix", async () => {
    const o = options({ tasks: ["T-4", "T-3"], timeoutMs: 80, sigkillGraceMs: 40 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const loaded = { loadSample: () => ({ load1: 22, swapFreeBytes: 8 * 1024 ** 3 }), loadSampleMs: 5, now: minuteClock() };
    await expect(runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ hang: true, ignoreTerm: true }, seen), ...loaded }))).rejects.toBeInstanceOf(MachineLoadStopError);
    expect(seen).toHaveLength(1);
    const pub = pubDirOf(o, pf);
    const record = JSON.parse(readFileSync(join(pub, "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.killKind).toBe("timeout"); expect(record.validity).toBe("invalid"); expect(record.invalidReasons).toEqual(["machine-load"]);
    expect(record.machineLoadStop).toMatch(/^load rule breached for \d+ min from \+0 min$/);
    const load = JSON.parse(readFileSync(join(pub, "load.json"), "utf-8")) as { rule: unknown; samples: Record<string, unknown>[] };
    expect(load.rule).toEqual(LOAD_RULE); expect(load.samples.length).toBeGreaterThanOrEqual(6); expect(load.samples.every((x) => x.load1 === 22)).toBe(true);
    // Offsets from the attempt start, never clock timestamps: the minute clock starts the attempt at 60 000.
    expect(load.samples.every((x) => !("t" in x) && typeof x.offsetMs === "number")).toBe(true);
    expect(load.samples[0]!.offsetMs).toBe(60_000);
    const expDir = join(o.out, pf.experiment.slice(0, 12));
    expect(JSON.parse(readFileSync(join(expDir, "experiment.json"), "utf-8")).qualification.reason).toBe("a timeout under the pre-registered machine-load rule; re-run the same command when the machine is quiet");
    expect(existsSync(join(expDir, "T-3"))).toBe(false);
  });

  it("the sampling timer stops with the attempt, so no sample leaks past it", async () => {
    let samples = 0;
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen), loadSample: () => { samples++; return { load1: 1, swapFreeBytes: 8 * 1024 ** 3 }; }, loadSampleMs: 5 }));
    const atEnd = samples;
    await new Promise((r) => setTimeout(r, 40));
    expect(samples).toBe(atEnd);
  });

  it("the same load never invalidates a completed attempt, and a quiet timeout stays a behavioural failure", async () => {
    const hot = () => ({ loadSample: () => ({ load1: 22, swapFreeBytes: 1024 }), loadSampleMs: 5, now: minuteClock() });
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const done = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen), ...hot() }));
    expect(done.validity).toBe("valid"); expect(done.machineLoad).toBe(false);
    const o2 = options({ timeoutMs: 80, sigkillGraceMs: 40 });
    const t = await runAttempt(o2, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ hang: true, ignoreTerm: true }, seen), loadSampleMs: 5, now: minuteClock() }));
    expect(t.validity).toBe("valid"); expect(t.machineLoad).toBe(false); expect(t.completion).toBe("incomplete");
  });

  it("fresh isolation provisions a distinct config dir per attempt, each hashing to the experiment's fingerprint, removed afterwards", async () => {
    const o = options({ repeats: 2 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(seen).toHaveLength(2);
    const dirs = seen.map((s) => s.env.CLAUDE_CONFIG_DIR!);
    expect(new Set(dirs).size).toBe(2);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
    for (const rep of [1, 2]) expect(JSON.parse(readFileSync(join(pubDirOf(o, pf, "T-4", rep), "manifest.json"), "utf-8")).configHashBefore).toBe(pf.configHash);
    for (const s of seen) for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(s.env[k]).toBeUndefined();
  });

  it("the full 15-cell matrix with complete evidence QUALIFIES; one blocked artefact stops the matrix where it happens", async () => {
    const full = options({ tasks: [...TASKS], repeats: 3 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const ok = await runMatrix(full, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(seen).toHaveLength(15);
    expect(ok.qualifying).toBe(true);
    expect(existsSync(join(full.out, pf.experiment.slice(0, 12), "QUALIFYING"))).toBe(true);
    // An observation that cannot publish its evidence disqualifies the whole experiment, so the matrix stops at
    // it rather than spending the remaining cells on a result that can never be cited. Two live captures were
    // lost that way, one running 4 cells past the point of no return and the next 6.
    const o2 = options({ tasks: [...TASKS], repeats: 3 }); const seen2: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const leak = (t: string): string | undefined => (t === "T-3" ? "# handover\n\nleaked sk-ant-api03-verysecret0123456789 and /Volumes/private/x.csv\n" : undefined);
    await expect(runMatrix(o2, pf, deps({ spawnFn: fakeSpawn({ complete: true, handoverText: leak }, seen2) }))).rejects.toThrow(/incomplete evidence/);
    expect(seen2).toHaveLength(10); // T-2.a, T-2.b and T-2.c complete (9), then T-3#1 stops it
    const exp = JSON.parse(readFileSync(join(o2.out, pf.experiment.slice(0, 12), "experiment.json"), "utf-8")) as { qualification: { qualifying: boolean; reason: string } };
    expect(exp.qualification.qualifying).toBe(false);
    expect(exp.qualification.reason).toContain("T-3#1 published incomplete evidence");
    expect(existsSync(join(o2.out, pf.experiment.slice(0, 12), "QUALIFYING"))).toBe(false);
    // The rule the stop enforces, pinned directly: one unpublished observation is enough to disqualify.
    const cells = [...TASKS].flatMap((task) => [1, 2, 3].map((repeat) => ({ task, repeat, satisfied: true, evidenceComplete: !(task === "T-3" && repeat === 1) })));
    expect(qualifies({ cells, isolation: "fresh", pilot: PILOT_OK })).toMatchObject({ qualifying: false, unpublishedCells: ["T-3#1"] });
  }, 120_000);

  it("a blocked artefact stays private, the observation stands, and evidence completeness is recorded on the cell", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await expect(runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true, handoverText: "# handover\n\nleaked sk-ant-api03-verysecret0123456789 and /Volumes/private/x.csv\n" }, seen) }))).rejects.toThrow(/incomplete evidence/);
    const pub = pubDirOf(o, pf); const raw = rawDirOf(o, pf);
    expect(existsSync(join(pub, "handover.md"))).toBe(false);
    expect(existsSync(join(raw, "unpublished.handover.md"))).toBe(true);
    const record = JSON.parse(readFileSync(join(pub, "record.json"), "utf-8")) as { validity: string; completion: string; evidenceComplete: boolean };
    expect(record).toMatchObject({ validity: "valid", completion: "completed", evidenceComplete: false });
    const redaction = JSON.parse(readFileSync(join(pub, "redaction.json"), "utf-8")) as { blockedLabels: Record<string, Record<string, number>>; blocked?: unknown };
    // The path is now substituted to <ABS> by the sanitiser; the credential is still REFUSED, which is what withholds the artefact.
    expect(redaction.blockedLabels["handover.md"]).toEqual({ "sk-ant": 1, "sk-key": 1 });
    expect(redaction.blocked).toBeUndefined();
    expect(readFileSync(join(pub, "redaction.json"), "utf-8")).not.toContain("verysecret");
    const exp = JSON.parse(readFileSync(join(o.out, pf.experiment.slice(0, 12), "experiment.json"), "utf-8")) as { cells: { evidenceComplete: boolean; satisfied: boolean }[] };
    expect(exp.cells[0]).toMatchObject({ satisfied: true, evidenceComplete: false });
    expect(decideCell(readAttempts(join(o.out, pf.experiment.slice(0, 12), "T-4", "repeat-1")), pf.experiment, { task: "T-4", repeat: 1 })).toEqual({ kind: "satisfied", attempt: "attempt-001", evidenceComplete: false });
  });

  it("an operator signal during a timeout's grace period still classifies the attempt as interrupted", async () => {
    const o = options({ timeoutMs: 40, sigkillGraceMs: 300 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const signals = new EventEmitter();
    const spawnFn = fakeSpawn({ hang: true, ignoreTerm: true }, seen);
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: (c, a, opt) => { const ch = spawnFn(c, a, opt); setTimeout(() => signals.emit("SIGINT"), 120); return ch; }, signals }));
    expect(r.interrupted).toBe(true);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as Record<string, unknown>;
    expect(record.killKind).toBe("runner-signal");
    expect(record.invalidReasons).toContain("interrupted");
  });

  it("plan.initial.md belongs to the first main-session plan_written call only; a later copy never substitutes and subagent calls are ignored", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    // The first main-session plan_written arrives while plan.md does not exist yet; a subagent call and a second main call follow once it does.
    const spawnFn: SpawnFn = (_c, args, options) => {
      const cwd = options.cwd as string;
      const child = new FakeChild(false);
      seen.push({ cwd, env: options.env as NodeJS.ProcessEnv, child });
      const sessionDir = join(cwd, ".story", "sessions", SID);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ state: "IMPLEMENT", status: "active", binaryFingerprint: { mtime: 1, sha256: FAKE_DIST["dist/mcp.js"] }, completedTickets: [] }));
      speakLaunch(child, args, cwd, () => setTimeout(() => {
        child.stdout.write(`${POLICY_INIT}\n${assistant("r1", [{ type: "tool_use", id: "t1", name: guide, input: { sessionId: null, action: "start" } }], u(1, 0, 1))}\n${toolResult("t1", stateLine("PLAN"))}\n`);
        child.stdout.write(`${assistant("r2", [{ type: "tool_use", id: "first", name: guide, input: { report: { completedAction: "plan_written" } } }], u(1, 0, 2))}\n${toolResult("first", stateLine("PLAN_REVIEW"))}\n`);
        writeFileSync(join(sessionDir, "plan.md"), "# revised plan\n");
        child.stdout.write(`${assistant("r3", [{ type: "tool_use", id: "sub", name: guide, input: { report: { completedAction: "plan_written" } } }], u(1, 0, 3), "parent-x")}\n${toolResult("sub", stateLine("PLAN"), "parent-x")}\n`);
        child.stdout.write(`${assistant("r4", [{ type: "tool_use", id: "second", name: guide, input: { report: { completedAction: "plan_written" } } }], u(1, 0, 4))}\n${toolResult("second", stateLine("IMPLEMENT"))}\n`);
        child.finish(0, null);
      }, 5));
      return child as unknown as ChildProcess;
    };
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn }));
    expect(r.evidenceComplete).toBe(false);
    const pub = pubDirOf(o, pf);
    expect(existsSync(join(pub, "plan.initial.md"))).toBe(false);
    expect(existsSync(join(pub, "plan.round-2.md"))).toBe(true);
    const record = JSON.parse(readFileSync(join(pub, "record.json"), "utf-8")) as { planCopies: { toolUseId: string; file: string }[]; requiredArtefacts: string[]; validity: string };
    expect(record.planCopies).toEqual([{ toolUseId: "second", file: "plan.round-2.md" }]);
    expect(record.requiredArtefacts).toContain("plan.initial.md");
    expect(record.validity).toBe("valid");
  });

  it("a non-MCP bundle changing between attempts is refused before the spawn, and drift during an attempt invalidates it", async () => {
    const o = options({ repeats: 2 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    let calls = 0;
    const drifting = (): Record<string, string> => { calls++; return calls > 2 ? { ...FAKE_DIST, "dist/cli.js": "9".repeat(64) } : fakeDist(); };
    await expect(runMatrix(o, pf, { spawnFn: fakeSpawn({ complete: true }, seen), distHashes: drifting, inputHashes: fakeInputs })).rejects.toThrow(/dist\/ changed since preflight \(dist\/cli.js\)/);
    expect(seen).toHaveLength(1);
    const o2 = options(); const seen2: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    let n = 0;
    const midRun = (): Record<string, string> => { n++; return n === 2 ? { ...FAKE_DIST, "dist/presence.js": "8".repeat(64) } : fakeDist(); };
    const r = await runAttempt(o2, pf, "T-4", 1, 1, { spawnFn: fakeSpawn({ complete: true }, seen2), distHashes: midRun, inputHashes: fakeInputs });
    expect(r.validity).toBe("invalid");
    expect((JSON.parse(readFileSync(join(pubDirOf(o2, pf), "record.json"), "utf-8")) as { invalidReasons: string[] }).invalidReasons).toEqual(["build-drift"]);
  });

  it("the machine-load rule's evidence is required: a capture stripped of load.json is refused by the verifier, naming it", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    const pub = pubDirOf(o, pf);
    expect(verifyAttemptDir(pub)).toMatchObject({ evidenceComplete: true, reason: null });
    const manifestPath = join(pub, "artefacts.sha256.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, string>;
    delete manifest["load.json"]; writeFileSync(manifestPath, JSON.stringify(manifest)); rmSync(join(pub, "load.json"));
    expect(verifyAttemptDir(pub)).toMatchObject({ evidenceComplete: false, reason: "required artefact load.json not in manifest" });
  });
  it("required evidence follows the lifecycle: a plan_written report without a captured plan leaves evidence incomplete", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true, noPlanFile: true }, seen) }));
    expect(r.evidenceComplete).toBe(false);
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as { requiredArtefacts: string[]; published: Record<string, boolean> };
    expect(record.requiredArtefacts).toContain("plan.initial.md");
    expect(record.requiredArtefacts).toContain("plan.md");
    expect(record.published["plan.initial.md"]).toBeUndefined();
  });

  it("an intact attempt copied into another cell cannot satisfy it on resume", async () => {
    const o = options({ repeats: 2 }); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    const src = pubDirOf(o, pf, "T-4", 1); const dst = pubDirOf(o, pf, "T-4", 2);
    mkdirSync(dirname(dst), { recursive: true });
    execFileSync("cp", ["-R", src, dst]);
    const r = await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(seen).toHaveLength(2);
    expect(r.summary.some((l) => l.startsWith("T-4#2: ignored foreign records: attempt-001 records T-4#1"))).toBe(true);
    expect(existsSync(pubDirOf(o, pf, "T-4", 2, "attempt-002"))).toBe(true);
  });

  it("on restart a satisfied cell is not rerun, a stale QUALIFYING marker is removed, and a missing cell keeps the experiment incomplete", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    const expDir = join(o.out, pf.experiment.slice(0, 12));
    writeFileSync(join(expDir, "QUALIFYING"), "stale");
    const r = await runMatrix(o, pf, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(seen).toHaveLength(1);
    expect(r.qualifying).toBe(false);
    expect(r.reason).toMatch(/missing cells: T-2.a#1/);
    expect(existsSync(join(expDir, "QUALIFYING"))).toBe(false);
  });
});

describe("fixture materialisation", () => {
  it("applies title and description overrides; variant c carries no discovery keyword; arm 2 has no catalogs", () => {
    const dest = tmp("cont-mat-");
    const m = materialize(FIXTURE, 2, "T-2.c", dest);
    const t2 = JSON.parse(readFileSync(join(dest, ".story", "tickets", "T-2.json"), "utf-8")) as { title: string; description: string };
    expect(t2.title).toBe("Make failed background jobs traceable to the originating request");
    expect(m.variant).toEqual({ title: t2.title, description: t2.description });
    expect(variantDiscoveryViolations("T-2.c", m.variant!)).toEqual([]);
    expect(variantDiscoveryViolations("T-2.c", { title: "Add logging", description: "in src/jobs" })).toHaveLength(2);
    expect(existsSync(join(dest, ".story", "capabilities.json"))).toBe(false);
    expect(existsSync(join(dest, "src", "platform", "logging", "AppLogger.ts"))).toBe(true);
    expect(materialize(FIXTURE, 1, "T-3", tmp("cont-mat-")).variant).toBeNull();
  });
  it("the fixture app's tests run before the T-3 move, fail with a stale consumer import, and pass once every import is updated", () => {
    const dest = tmp("cont-app-");
    materialize(FIXTURE, 1, "T-3", dest);
    // Precondition: the fixture app's tests are .ts files, which a bare `node --test` finds and runs only on a node
    // that strips types by default (22.18.0 or later on 22, 23.6.0 or later). An older node reports "tests 0".
    const version = execFileSync("node", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
    const stripsTypes = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
    expect(stripsTypes, `the node on PATH is ${version}; this row needs node 22.18.0 or later (23.6.0 or later on 23) to run the fixture app's .ts tests`).toBe(true);
    const run = (): string => execFileSync("node", ["--test"], { cwd: dest, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run()).toMatch(/# pass 4\n# fail 0/);
    mkdirSync(join(dest, "packages"), { recursive: true });
    execFileSync("mv", [join(dest, "src", "platform", "logging"), join(dest, "packages", "logging")]);
    expect(() => run()).toThrow();
    for (const f of ["src/http/router.ts", "src/http/handler.ts"]) writeFileSync(join(dest, f), readFileSync(join(dest, f), "utf-8").replace("../platform/logging/AppLogger.ts", "../../packages/logging/AppLogger.ts"));
    expect(run()).toMatch(/# pass 4\n# fail 0/);
  });
});

describe("suite boundary", () => {
  it("vitest's own unfiltered file listing excludes the fixture app's node:test files, and only because of the exclusion", () => {
    const list = (config?: string): string[] => {
      const args = ["vitest", "list", "--filesOnly", "--root", PKG, ...(config ? ["--config", config] : [])];
      return execFileSync("npx", args, { cwd: PKG, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } }).split("\n").map((l) => l.trim()).filter(Boolean);
    };
    const files = list();
    expect(files.some((f) => f.endsWith("test/tooling/continuity-run.test.ts"))).toBe(true);
    expect(files.some((f) => f.includes("fixtures/continuity/core/"))).toBe(false);
    const cfgDir = tmp("cont-vitest-cfg-");
    const cfg = join(cfgDir, "vitest.noexclude.config.mjs");
    writeFileSync(cfg, `import { defineConfig } from "${join(PKG, "node_modules", "vitest", "dist", "config.js")}";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["**/node_modules/**"] } });\n`);
    const unguarded = list(cfg);
    expect(unguarded.some((f) => f.endsWith("fixtures/continuity/core/src/platform/logging/AppLogger.test.ts"))).toBe(true);
  }, 60_000);
});

const MANIFEST = { arm: 1, model: "m", effort: "high", isolation: "fresh", ownerException: null, build: { storybloqVersion: "1.15.9" } };

describe("scoring", () => {
  const good = (task: string, init: boolean, fin: boolean): Record<string, unknown> => ({
    rubricVersion: 1, task,
    initial: Object.fromEntries(["C1", "C2", "C3", "C4", "C5"].map((c) => [c, { pass: init, evidence: `${c} evidence` }])),
    final: Object.fromEntries(["C1", "C2", "C3", "C4", "C5"].map((c) => [c, { pass: fin, evidence: `${c} evidence` }])),
    scorer: { provider: "codex", observedModel: "gpt-6-astra" },
  });
  const rubric = readFileSync(join(FIXTURE, "rubric.md"), "utf-8");
  it("validates a verdict fully: booleans, evidence strings, all criteria at both checkpoints, task and scorer", () => {
    const s = validateScore(good("T-3", true, false), { rubricVersion: "1", task: "T-3" });
    expect(s.initial.C1.pass).toBe(true);
    expect(() => validateScore(good("T-3", true, false), { rubricVersion: "2", task: "T-3" })).toThrow(/rubricVersion/);
    expect(() => validateScore(good("T-4", true, false), { rubricVersion: "1", task: "T-3" })).toThrow(/task/);
    const stringy = good("T-3", true, false) as { initial: Record<string, { pass: unknown }> };
    stringy.initial.C2 = { pass: "false" };
    expect(() => validateScore(stringy, { rubricVersion: "1", task: "T-3" })).toThrow(/C2.pass must be a boolean/);
    const missing = good("T-3", true, false) as { final: Record<string, unknown> };
    delete missing.final.C5;
    expect(() => validateScore(missing, { rubricVersion: "1", task: "T-3" })).toThrow(/final.C5 missing/);
    const noModel = good("T-3", true, false) as { scorer: unknown };
    noModel.scorer = { provider: "codex" };
    expect(() => validateScore(noModel, { rubricVersion: "1", task: "T-3" })).toThrow(/observedModel/);
  });
  it("aggregates over counted observations at the frozen checkpoints, unscored ones staying in the denominator", () => {
    const obs = (task: string, repeat: number, score: Record<string, unknown> | null): Observation => ({ task, repeat, attemptDir: "/x", record: baseRecord({ task, repeat }) as AttemptRecord, score: score ? validateScore(score, { rubricVersion: "1", task }) : null, problem: null, provenance: { arm: 1, model: "m", effort: "high", storybloqVersion: "1.15.9", isolation: "fresh", ownerExceptionId: null } });
    const agg = aggregate([obs("T-3", 1, good("T-3", true, false)), obs("T-3", 2, good("T-3", true, false)), obs("T-3", 3, null)]);
    expect(agg["T-3"]!.C1).toEqual({ initialPass: 2, finalPass: 0, scored: 2, observations: 3, comparisonPass: 2 });
    expect(agg["T-3"]!.C5).toEqual({ initialPass: 2, finalPass: 0, scored: 2, observations: 3, comparisonPass: 0 });
    expect(COMPARISON_CHECKPOINT).toEqual({ C1: "initial", C2: "initial", C3: "final", C4: "final", C5: "final" });
  });
  it("behavioural failures are scored mechanically as all-fail, and the request carries the verbatim prompt with arm, task and fixture map", () => {
    const failed = baseRecord({ task: "T-4", completion: "incomplete", completionReason: "no plan" }) as AttemptRecord;
    const m = mechanicalFailureScore(failed, "1");
    expect(Object.values(m.initial).every((c) => c.pass === false)).toBe(true);
    expect(m.scorer.provider).toBe("mechanical");
    const d = join(tmp("cont-score-"), "attempt-001");
    writeAttempt(d, baseRecord({ task: "T-4" }), {});
    const req = scoringRequest(d, rubric, "{\"rulings\":{}}");
    expect(req).toContain("You are scoring one recorded autonomous coding session");
    expect(req).toContain("arm 1, task T-4, repeat 1");
    expect(req).toContain("## fixture-map.json");
    expect(req).toContain("(absent: plan.initial.md)");
  });
  it("stored scores are validated on load; a copied, malformed or non-mechanical failure score is rejected with a reason", () => {
    const d = join(tmp("cont-load-"), "attempt-001");
    writeAttempt(d, baseRecord({ task: "T-3" }), {});
    const rec = baseRecord({ task: "T-3" }) as AttemptRecord;
    expect(loadScore(d, rec, "1")).toEqual({ score: null, problem: null });
    writeFileSync(join(d, "score.rubric1.json"), JSON.stringify(good("T-4", true, true)));
    expect(loadScore(d, rec, "1").problem).toMatch(/score task T-4 != attempt task T-3/);
    const stringy = good("T-3", true, true) as { initial: Record<string, unknown> }; stringy.initial.C1 = { pass: "false", evidence: "" };
    writeFileSync(join(d, "score.rubric1.json"), JSON.stringify(stringy));
    expect(loadScore(d, rec, "1").problem).toMatch(/must be a boolean/);
    writeFileSync(join(d, "score.rubric1.json"), JSON.stringify(good("T-3", true, true)));
    expect(loadScore(d, rec, "1").score?.initial.C1.pass).toBe(true);
    const failedRec = baseRecord({ task: "T-3", completion: "incomplete", completionReason: "x" }) as AttemptRecord;
    expect(loadScore(d, failedRec, "1").problem).toMatch(/not the mechanical all-fail result/);
    writeFileSync(join(d, "score.rubric1.json"), JSON.stringify(mechanicalFailureScore(failedRec, "1")));
    expect(loadScore(d, failedRec, "1").score?.scorer.provider).toBe("mechanical");
  });
  it("every scorer output goes through the publication-checked writer, which refuses blocked content", () => {
    const d = tmp("cont-pub-");
    expect(() => publishText(join(d, "a.md"), "fine text with Bearer abc", ["Bearer abc"])).not.toThrow();
    // An unknown absolute path is identity, not a secret: the sanitiser substitutes it and the write succeeds.
    expect(() => publishText(join(d, "b.md"), "rubric now mentions /Users/someone/private.md", [])).not.toThrow();
    expect(readFileSync(join(d, "b.md"), "utf-8")).toBe("rubric now mentions <ABS>");
    expect(() => publishText(join(d, "c.json"), JSON.stringify({ evidence: "saw sk-ant-api03-secret0123456789abcdef" }), [])).toThrow(/sk-ant/);
  });
  it("the report counts exactly the verified attempt per preregistered cell, names verification failures, and withholds citability", () => {
    const expDir = tmp("cont-report-");
    const E = "e".repeat(64);
    const cell = (task: string, repeat: number, score: boolean, tamper = false): void => {
      const dir = join(expDir, task, `repeat-${repeat}`, "attempt-001");
      writeAttempt(dir, baseRecord({ task, repeat, experimentHash: E, requiredArtefacts: ["evidence.jsonl", "manifest.json"] }), { "evidence.jsonl": "e", "manifest.json": JSON.stringify(MANIFEST) });
      if (score) writeFileSync(join(dir, "score.rubric1.json"), JSON.stringify(good(task, true, true)));
      if (tamper) writeFileSync(join(dir, "evidence.jsonl"), "changed after capture");
    };
    cell("T-4", 1, true); cell("T-4", 2, false); cell("T-4", 3, true, true);
    const exp = { experimentHash: E, arm: 1, model: "m", effort: "high", isolation: "fresh", ownerException: null, build: { storybloqVersion: "1.15.9" }, cells: [1, 2, 3].map((repeat) => ({ task: "T-4", repeat, satisfied: true, evidenceComplete: true, attempt: "attempt-001" })), qualification: { qualifying: true, reason: "all", shortCells: [] } };
    const { observations, failures } = selectObservations(expDir, exp, "1");
    expect(observations.map((o) => [o.repeat, o.score !== null])).toEqual([[1, true], [2, false]]);
    // The tampered cell plus the twelve cells this partial experiment.json never listed.
    expect(failures).toContain("T-4#3: artefact evidence.jsonl missing or changed");
    expect(failures.filter((f) => f.endsWith("absent from experiment.json"))).toHaveLength(12);
    expect(failures).toHaveLength(13);
    const text = renderReport(exp, aggregate(observations), observations, failures, "1");
    expect(text).toContain("Evidence verification: **FAILED (13)**");
    expect(text).toContain("Scoring: **INCOMPLETE (1 observation(s) unscored, 13 cell(s) unverifiable)**");
    expect(text).toContain("NOT citable");
    expect(text).toContain("- T-4#3: artefact evidence.jsonl missing or changed");
    expect(text).toMatch(/\| T-4 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/2 \|/);
    const foreign = selectObservations(expDir, { ...exp, experimentHash: "f".repeat(64) }, "1");
    expect(foreign.observations).toEqual([]);
    expect(foreign.failures.some((f) => /belongs to experiment eeeeeeeeeeee/.test(f))).toBe(true);
  });
  it("a shared run captured without an exception stays non-citable whatever experiment.json claims", () => {
    const expDir = tmp("cont-shared-");
    const E = "e".repeat(64);
    const allCells = TASKS.flatMap((task) => [1, 2, 3].map((repeat) => ({ task, repeat, satisfied: true, evidenceComplete: true, attempt: "attempt-001" })));
    for (const c of allCells) {
      const dir = join(expDir, c.task, `repeat-${c.repeat}`, "attempt-001");
      writeAttempt(dir, baseRecord({ task: c.task, repeat: c.repeat, experimentHash: E, requiredArtefacts: ["manifest.json"] }), { "manifest.json": JSON.stringify({ ...MANIFEST, isolation: "shared" }) });
      writeFileSync(join(dir, "score.rubric1.json"), JSON.stringify(good(c.task, true, true)));
    }
    const honest = { experimentHash: E, arm: 1, model: "m", effort: "high", isolation: "shared", ownerException: null, build: { storybloqVersion: "1.15.9" }, cells: allCells, qualification: { qualifying: false, reason: "shared isolation without a recorded owner exception", shortCells: [] } };
    const h = selectObservations(expDir, honest, "1");
    expect(h.failures).toEqual([]); expect(h.observations).toHaveLength(15);
    expect(renderReport(honest, aggregate(h.observations), h.observations, h.failures, "1")).toContain("NOT citable");
    for (const forged of [{ ...honest, isolation: "fresh", qualification: { qualifying: true, reason: "forged", shortCells: [] } }, { ...honest, ownerException: { id: "r-aaaaaaaaaaaaaaaa" }, qualification: { qualifying: true, reason: "forged", shortCells: [] } }]) {
      const f = selectObservations(expDir, forged, "1");
      expect(f.observations).toEqual([]);
      expect(f.failures).toHaveLength(15);
      expect(renderReport(forged, aggregate(f.observations), f.observations, f.failures, "1")).toContain("NOT citable");
    }
  });
  it("a verdict written to the prompt's template passes validateScore", () => {
    const rubric = readFileSync(join(FIXTURE, "rubric.md"), "utf-8");
    expect(rubric).toContain('"scorer":{"provider":"codex","observedModel":"<model id observed>"');
    const templated = { rubricVersion: 1, task: "T-3", initial: Object.fromEntries(["C1", "C2", "C3", "C4", "C5"].map((c) => [c, { pass: true, evidence: "t1" }])), final: Object.fromEntries(["C1", "C2", "C3", "C4", "C5"].map((c) => [c, { pass: false, evidence: "missing-evidence" }])), flags: ["missing-evidence"], notes: "n", scorer: { provider: "codex", observedModel: "gpt-6-astra", sessionId: "01a0" } };
    expect(validateScore(templated, { rubricVersion: "1", task: "T-3" }).scorer.sessionId).toBe("01a0");
  });
  it("citability is recomputed from verified observations: a stale qualifying flag with missing, duplicated or empty cells never yields a citable report", () => {
    const expDir = tmp("cont-recompute-");
    const E = "e".repeat(64);
    const base = { experimentHash: E, arm: 1, model: "m", effort: "high", isolation: "fresh", ownerException: null, build: { storybloqVersion: "1.15.9" }, qualification: { qualifying: true, reason: "stale", shortCells: [] } };
    const allCells = TASKS.flatMap((task) => [1, 2, 3].map((repeat) => ({ task, repeat, satisfied: true, evidenceComplete: true, attempt: "attempt-001" })));
    for (const c of allCells) {
      const dir = join(expDir, c.task, `repeat-${c.repeat}`, "attempt-001");
      writeAttempt(dir, baseRecord({ task: c.task, repeat: c.repeat, experimentHash: E, requiredArtefacts: ["manifest.json"] }), { "manifest.json": JSON.stringify(MANIFEST) });
      writeFileSync(join(dir, "score.rubric1.json"), JSON.stringify(good(c.task, true, true)));
    }
    const full = selectObservations(expDir, { ...base, cells: allCells }, "1");
    expect(full.failures).toEqual([]);
    // ISS-1486 D9: without the arm's verified pilot beside the attempts, nothing is citable; with it, the cells decide.
    expect(renderReport({ ...base, cells: allCells }, aggregate(full.observations), full.observations, full.failures, "1")).toContain("NOT citable");
    writePilot(expDir, E, 1);
    expect(renderReport({ ...base, cells: allCells }, aggregate(full.observations), full.observations, full.failures, "1")).toContain("This file is citable as the release baseline.");
    const empty = selectObservations(expDir, { ...base, cells: [] }, "1");
    expect(empty.failures).toHaveLength(15);
    expect(renderReport({ ...base, cells: [] }, aggregate(empty.observations), empty.observations, empty.failures, "1")).toContain("NOT citable");
    const missing = selectObservations(expDir, { ...base, cells: allCells.slice(0, 14) }, "1");
    expect(missing.failures).toEqual(["T-4#3: absent from experiment.json"]);
    const missingText = renderReport({ ...base, cells: allCells.slice(0, 14) }, aggregate(missing.observations), missing.observations, missing.failures, "1");
    expect(missingText).toMatch(/Capture \(recomputed from verified observations\): \*\*INCOMPLETE\*\* \(1 cell\(s\) without a valid observation: T-4#3\) \[saved flag said QUALIFYING: stale\]/);
    expect(missingText).toContain("NOT citable");
    // Isolation and exception provenance come from the verified manifests: relabelling experiment.json cannot make a run citable.
    const relabelled = selectObservations(expDir, { ...base, cells: allCells, isolation: "shared", ownerException: { id: "r-aaaaaaaaaaaaaaaa" } }, "1");
    expect(relabelled.observations).toEqual([]);
    expect(relabelled.failures[0]).toMatch(/experiment identity disagrees \(isolation: manifest fresh, experiment.json shared; ownerExceptionId: manifest none, experiment.json r-aaaaaaaaaaaaaaaa\)/);
    // Arm, model, effort and build version are verified the same way: relabelling any one of them makes every cell unverifiable and the report non-citable.
    for (const forged of [{ arm: 3 }, { model: "claude-sonnet-5" }, { effort: "low" }, { build: { storybloqVersion: "1.16.0" } }]) {
      const r = selectObservations(expDir, { ...base, cells: allCells, ...forged }, "1");
      expect(r.observations).toEqual([]); expect(r.failures).toHaveLength(15);
      expect(r.failures[0]).toMatch(/experiment identity disagrees/);
      const report = renderReport({ ...base, cells: allCells, ...forged }, aggregate(r.observations), r.observations, r.failures, "1");
      expect(report).toContain("NOT citable"); expect(report).toContain("experiment identity UNVERIFIED");
    }
    const honestReport = renderReport({ ...base, cells: allCells }, aggregate(selectObservations(expDir, { ...base, cells: allCells }, "1").observations), selectObservations(expDir, { ...base, cells: allCells }, "1").observations, [], "1");
    expect(honestReport).toContain("arm 1, storybloq 1.15.9"); expect(honestReport).toContain("all from verified attempt manifests");
    const dup = selectObservations(expDir, { ...base, cells: [...allCells.slice(0, 14), allCells[0]!] }, "1");
    expect(dup.failures).toEqual(["T-2.a#1: listed twice in experiment.json", "T-4#3: absent from experiment.json"]);
    expect(dup.observations).toHaveLength(15);
    expect(renderReport({ ...base, cells: [...allCells.slice(0, 14), allCells[0]!] }, aggregate(dup.observations), dup.observations, dup.failures, "1")).toContain("NOT citable");
  });
  it("G10: a record with no launch policy, or another one, is refused by the runner and the scorer alike, with a valid pilot beside it", () => {
    const E = "e".repeat(64);
    const base = { experimentHash: E, arm: 1, model: "m", effort: "high", isolation: "fresh", ownerException: null, build: { storybloqVersion: "1.15.9" }, qualification: { qualifying: true, reason: "stale", shortCells: [] } };
    const allCells = TASKS.flatMap((task) => [1, 2, 3].map((repeat) => ({ task, repeat, satisfied: true, evidenceComplete: true, attempt: "attempt-001" })));
    for (const bad of ["absent", 1, "2"] as const) {
      const expDir = tmp("cont-g10-");
      writePilot(expDir, E, 1);
      for (const c of allCells) {
        const dir = join(expDir, c.task, `repeat-${c.repeat}`, "attempt-001");
        const rec = baseRecord({ task: c.task, repeat: c.repeat, experimentHash: E, requiredArtefacts: ["manifest.json"] });
        if (c.task === "T-4" && c.repeat === 1) { if (bad === "absent") delete rec.launchPolicy; else rec.launchPolicy = bad; }
        writeAttempt(dir, rec, { "manifest.json": JSON.stringify(MANIFEST) });
        writeFileSync(join(dir, "score.rubric1.json"), JSON.stringify(good(c.task, true, true)));
      }
      const s = selectObservations(expDir, { ...base, cells: allCells }, "1");
      expect(s.failures, String(bad)).toEqual([`T-4#1: attempt was not captured under launch policy ${LAUNCH_POLICY}`]);
      expect(s.observations).toHaveLength(14);
      expect(renderReport({ ...base, cells: allCells }, aggregate(s.observations), s.observations, s.failures, "1")).toContain("NOT citable");
      // The runner reads the same record and never counts it for its cell; a conforming neighbour still satisfies its own.
      expect(decideCell(readAttempts(join(expDir, "T-4", "repeat-1")), E, { task: "T-4", repeat: 1 }).kind).toBe("run");
      expect(decideCell(readAttempts(join(expDir, "T-4", "repeat-2")), E, { task: "T-4", repeat: 2 }).kind).toBe("satisfied");
    }
    // The one check both sides use.
    expect(recordEligible({ launchPolicy: LAUNCH_POLICY })).toBe(true);
    for (const v of [undefined, null, 1, "2", 3]) expect(recordEligible({ launchPolicy: v })).toBe(false);
  });
});

// --- ISS-1273 / ISS-1274: per-path input identity, task material, drift under the run -------------

/** The arm-1 task material (experiment 0b1a4420, all five paths as committed at ea3ca8ec), pinned by hand in ISS-1273. */
const ARM1_TASK_MATERIAL = "8b4eb43e3a2667df559a7716f0b653c67c415cd8d194662cdec4f55d63b0cb05";
const ARM1_TASK_MATERIAL_PREFIXES: Record<string, string> = {
  "test/fixtures/continuity/core": "bc6a11e6f243bcb3",
  "test/fixtures/continuity/variants": "3ac441d1fde70db5",
  "test/fixtures/continuity/facts.json": "baccfe6cbc80e20c",
  "test/fixtures/continuity/fixture-map.json": "1f556f25be96409b",
  "test/fixtures/continuity/rubric.md": "57a91204fa90295c",
};
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" }).trim();

describe("ISS-1273: task material identity", () => {
  it("preflight's hash passes are bracketed: a path that moves or fails between the reads refuses the baseline", () => {
    const seq = (...rs: { hashes: Record<string, string>; errors: Record<string, string> }[]) => { let i = 0; return () => rs[Math.min(i++, rs.length - 1)]!; };
    const steady = { hashes: { src: "1".repeat(64), plugins: "2".repeat(64) }, errors: {} };
    const order: string[] = [];
    const ok = bracketedInputs(() => { order.push("read"); return steady; }, () => { order.push("compute"); return 7; });
    expect(order).toEqual(["read", "compute", "read"]);
    expect(ok).toEqual({ hashes: steady.hashes, value: 7 });
    expect(() => bracketedInputs(seq(steady, { hashes: { ...steady.hashes, src: "9".repeat(64) }, errors: {} }), () => 0)).toThrow(/input tree changed during preflight \(src\); rerun preflight/);
    expect(() => bracketedInputs(seq(steady, { hashes: { src: steady.hashes.src }, errors: { plugins: "EACCES" } }), () => 0)).toThrow(/input paths could not be hashed \(plugins\)/);
    expect(() => bracketedInputs(seq({ hashes: { src: steady.hashes.src }, errors: { plugins: "EACCES" } }, steady), () => 0)).toThrow(/input paths could not be hashed \(plugins\)/);
  });
  it("TRIPWIRE: the live fixture's task material is still arm 1's; an intentional edit re-pins this value and records it on the T-525 ledger item", () => {
    const tm = taskMaterial(PKG);
    const gate = "Deliberate gate (ISS-1273): the continuity task material (fixture core, variants, facts.json, fixture-map.json, rubric.md) no longer matches arm 1's, " +
      "so a cross-arm comparison against arm 1 would compare different tasks and is void. If the fixture edit is intentional, re-pin ARM1_TASK_MATERIAL here " +
      "and record the new value on the T-525 ledger item; otherwise revert the edit.";
    expect(tm.sha256, gate).toBe(ARM1_TASK_MATERIAL);
    expect(Object.keys(tm.paths)).toEqual(TM_LABELS);
    for (const [label, prefix] of Object.entries(ARM1_TASK_MATERIAL_PREFIXES)) expect(tm.paths[label]!.startsWith(prefix), `${label}: ${gate}`).toBe(true);
  });
  it("the task material is exactly the five fixture paths, all inside INPUT_PATHS, and the runner re-exports the lib's INPUT_PATHS", () => {
    expect([...TASK_MATERIAL]).toEqual(["core", "variants", "facts.json", "fixture-map.json", "rubric.md"]);
    expect(taskMaterialEntries("/p").map((e) => e.label)).toEqual(TM_LABELS);
    expect(taskMaterialEntries("/p")[0]!.path).toBe(join("/p", "test/fixtures/continuity/core"));
    for (const l of TM_LABELS) expect(INPUT_PATHS).toContain(l);
    expect(INPUT_PATHS).toBe(LIB_INPUT_PATHS);
  });
  it("per-path hashes move only the changed label; an absent path is a stable value, not a crash", () => {
    const d = tmp("cont-bypath-");
    mkdirSync(join(d, "a")); writeFileSync(join(d, "a", "x.txt"), "1"); writeFileSync(join(d, "b.txt"), "2");
    const entries = [{ label: "a", path: join(d, "a") }, { label: "b.txt", path: join(d, "b.txt") }, { label: "gone", path: join(d, "gone") }];
    const one = hashInputsByPath(entries);
    expect(one.errors).toEqual({});
    expect(Object.keys(one.hashes)).toEqual(["a", "b.txt", "gone"]);
    expect(one.hashes.a).toBe(hashInputs([entries[0]!]));
    expect(hashInputsByPath(entries).hashes.gone).toBe(one.hashes.gone);
    writeFileSync(join(d, "a", "x.txt"), "changed");
    const two = hashInputsByPath(entries);
    expect(driftedPaths(one.hashes, two.hashes)).toEqual(["a"]);
  });
  it("a per-path walk error is captured for its label instead of escaping", () => {
    const d = tmp("cont-bypath-err-");
    mkdirSync(join(d, "ok")); writeFileSync(join(d, "ok", "x.txt"), "1");
    mkdirSync(join(d, "locked")); writeFileSync(join(d, "locked", "x.txt"), "1");
    chmodSync(join(d, "locked"), 0o000);
    try {
      const r = hashInputsByPath([{ label: "ok", path: join(d, "ok") }, { label: "locked", path: join(d, "locked") }]);
      expect(Object.keys(r.hashes)).toEqual(["ok"]);
      expect(Object.keys(r.errors)).toEqual(["locked"]);
      expect(r.errors.locked).toMatch(/EACCES/);
    } finally { chmodSync(join(d, "locked"), 0o755); }
  });
  it("driftedPaths reports a changed value, an added key and a removed key, sorted", () => {
    expect(driftedPaths({ b: "1", a: "1", c: "1" }, { a: "2", b: "1", d: "1" })).toEqual(["a", "c", "d"]);
    expect(driftedPaths({ a: "1" }, { a: "1" })).toEqual([]);
  });
  it("ISS-1274 item 3: a plugins-source edit with dist unchanged is disclosed; every executed or unknown input invalidates", () => {
    expect([...NON_EXECUTED_INPUTS]).toEqual(["plugins"]);
    expect(classifyInputDrift(["plugins"], true)).toEqual({ invalidating: [], disclosed: ["plugins"] });
    expect(classifyInputDrift(["plugins"], false)).toEqual({ invalidating: ["plugins"], disclosed: [] });
    expect(classifyInputDrift(["src", "test/fixtures/continuity/rubric.md", "test/fixtures/continuity/overlays", "package.json", "scripts", "plugins"], true))
      .toEqual({ invalidating: ["src", "test/fixtures/continuity/rubric.md", "test/fixtures/continuity/overlays", "package.json", "scripts"], disclosed: ["plugins"] });
    expect(classifyInputDrift(["something-new"], true)).toEqual({ invalidating: ["something-new"], disclosed: [] });
  });
});

describe("ISS-1274: inputs are rechecked around every attempt", () => {
  const drifted = (label: string): Record<string, string> => ({ ...FAKE_INPUTS, [label]: "f".repeat(64) });
  /** Returns preflight values for the first `clean` calls, then `after`. */
  const provider = (clean: number, after: () => { hashes: Record<string, string>; errors: Record<string, string> }) => {
    let n = 0;
    return () => (++n <= clean ? fakeInputs() : after());
  };
  it("an unchanged tree records the per-path identity and an empty drift", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps({ spawnFn: fakeSpawn({ complete: true }, seen) }));
    expect(r.validity).toBe("valid");
    expect(r.inputDrift).toEqual({ invalidating: [], disclosed: [], errors: {} });
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as { inputDrift: unknown };
    expect(record.inputDrift).toEqual({ invalidating: [], disclosed: [], errors: {} });
    const manifest = JSON.parse(readFileSync(join(pubDirOf(o, pf), "manifest.json"), "utf-8")) as { inputHashes: unknown; taskMaterialHash: string; taskMaterialHashes: unknown; post: { inputHashesAfter: unknown } };
    expect(manifest.inputHashes).toEqual(FAKE_INPUTS);
    expect(manifest.taskMaterialHash).toBe(pf.taskMaterialHash);
    expect(manifest.taskMaterialHashes).toEqual(pf.taskMaterialHashes);
    expect(manifest.post.inputHashesAfter).toEqual(FAKE_INPUTS);
  });
  it("an executed input edited during the attempt invalidates it, naming the path", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: provider(1, () => ({ hashes: drifted("src"), errors: {} })) });
    expect(r.validity).toBe("invalid");
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as { invalidReasons: string[]; inputDrift: { invalidating: string[]; disclosed: string[] } };
    expect(record.invalidReasons).toEqual(["input-drift"]);
    expect(record.inputDrift.invalidating).toEqual(["src"]);
    expect(JSON.parse(readFileSync(join(pubDirOf(o, pf), "manifest.json"), "utf-8")).post.inputHashesAfter.src).toBe("f".repeat(64));
  });
  it("a plugins-only edit with dist unchanged leaves the attempt valid and discloses it", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runAttempt(o, pf, "T-4", 1, 1, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: provider(1, () => ({ hashes: drifted("plugins"), errors: {} })) });
    expect(r.validity).toBe("valid");
    expect(r.inputDrift).toEqual({ invalidating: [], disclosed: ["plugins"], errors: {} });
  });
  it("a hash-walk error after the attempt invalidates it and the invalid record is still published", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const after = (): { hashes: Record<string, string>; errors: Record<string, string> } => { const h = { ...FAKE_INPUTS }; delete h.scripts; return { hashes: h, errors: { scripts: "EACCES" } }; };
    const r = await runAttempt(o, pf, "T-4", 1, 1, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: provider(1, after) });
    expect(r.validity).toBe("invalid");
    const record = JSON.parse(readFileSync(join(pubDirOf(o, pf), "record.json"), "utf-8")) as { invalidReasons: string[]; inputDrift: { invalidating: string[]; errors: Record<string, string> } };
    expect(record.invalidReasons).toEqual(["input-drift"]);
    expect(record.inputDrift.invalidating).toEqual(["scripts"]);
    expect(record.inputDrift.errors).toEqual({ scripts: "EACCES" });
    expect(existsSync(join(pubDirOf(o, pf), "completed"))).toBe(true);
  });
  it("a walk error on plugins invalidates even with dist unchanged: an unreadable tree is never disclosed", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const after = (): { hashes: Record<string, string>; errors: Record<string, string> } => { const h = { ...FAKE_INPUTS }; delete h.plugins; return { hashes: h, errors: { plugins: "EACCES" } }; };
    const r = await runAttempt(o, pf, "T-4", 1, 1, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: provider(1, after) });
    expect(r.validity).toBe("invalid");
    expect(r.inputDrift).toEqual({ invalidating: ["plugins"], disclosed: [], errors: { plugins: "EACCES" } });
  });
  it("an invalidating drift or a walk error before the spawn refuses the attempt without spending it", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    await expect(runMatrix(o, pf, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: () => ({ hashes: drifted("src"), errors: {} }) })).rejects.toThrow(/input tree changed since preflight \(src\); rerun preflight/);
    expect(seen).toHaveLength(0);
    const errored = (): { hashes: Record<string, string>; errors: Record<string, string> } => { const h = { ...FAKE_INPUTS }; delete h["test/fixtures/continuity/rubric.md"]; return { hashes: h, errors: { "test/fixtures/continuity/rubric.md": "ENOENT" } }; };
    await expect(runMatrix(options(), pf, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: errored })).rejects.toThrow(/input tree changed since preflight \(test\/fixtures\/continuity\/rubric.md\)/);
    expect(seen).toHaveLength(0);
    // A disclosed-only drift before the spawn proceeds.
    const r = await runAttempt(options(), pf, "T-4", 1, 1, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: () => ({ hashes: drifted("plugins"), errors: {} }) });
    expect(r.validity).toBe("valid");
    expect(r.inputDrift.disclosed).toEqual(["plugins"]);
  });
  it("a mid-cell edit that is then reverted invalidates that attempt only; the cell re-runs and the summary names the path", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    let n = 0;
    const inputs = (): { hashes: Record<string, string>; errors: Record<string, string> } => (++n === 2 ? { hashes: drifted("test/fixtures/continuity/variants"), errors: {} } : fakeInputs());
    const r = await runMatrix(o, pf, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: inputs });
    expect(seen).toHaveLength(2);
    expect(r.summary).toContain("T-4#1 attempt-001: invalid completed INPUT DRIFT (test/fixtures/continuity/variants)");
    expect(r.summary).toContain("T-4#1: satisfied by attempt-002");
    const exp = JSON.parse(readFileSync(join(o.out, pf.experiment.slice(0, 12), "experiment.json"), "utf-8")) as { inputHashes: unknown; taskMaterialHash: string; taskMaterialHashes: unknown; inputTreeHash: string };
    expect(exp.inputHashes).toEqual(FAKE_INPUTS);
    expect(exp.taskMaterialHash).toBe(pf.taskMaterialHash);
    expect(exp.taskMaterialHashes).toEqual(pf.taskMaterialHashes);
    expect(exp.inputTreeHash).toBe("ith");
  });
  it("a disclosed drift is named on the summary line without invalidating", async () => {
    const o = options(); const pf = fakePreflight(); const seen: { cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const r = await runMatrix(o, pf, { ...deps({ spawnFn: fakeSpawn({ complete: true }, seen) }), inputHashes: provider(1, () => ({ hashes: drifted("plugins"), errors: {} })) });
    expect(r.summary).toContain("T-4#1 attempt-001: valid completed input drift disclosed (plugins)");
  });
});

describe("ISS-1273: cross-arm comparison refuses differing task material", () => {
  const TM = (over: Record<string, string> = {}): Record<string, string> => ({ ...Object.fromEntries(TM_LABELS.map((l) => [l, "1".repeat(64)])), ...over });
  const E = "e".repeat(64);
  /** An experiment directory whose manifests carry the given task material (or none, for a legacy capture). */
  function experiment(dir: string, perCell: (task: string, repeat: number) => Record<string, unknown>, cells = TASKS.flatMap((task) => [1, 2, 3].map((repeat) => ({ task, repeat })))): { expDir: string; exp: Parameters<typeof selectObservations>[1] } {
    for (const c of cells) {
      writeAttempt(join(dir, c.task, `repeat-${c.repeat}`, "attempt-001"), baseRecord({ task: c.task, repeat: c.repeat, experimentHash: E, requiredArtefacts: ["manifest.json"] }), { "manifest.json": JSON.stringify({ ...MANIFEST, ...perCell(c.task, c.repeat) }) });
    }
    const exp = { experimentHash: E, arm: 1, model: "m", effort: "high", isolation: "fresh", ownerException: null, build: { storybloqVersion: "1.15.9" }, cells: cells.map((c) => ({ ...c, satisfied: true, evidenceComplete: true, attempt: "attempt-001" })), qualification: { qualifying: true, reason: "all", shortCells: [] } };
    writeFileSync(join(dir, "experiment.json"), JSON.stringify(exp));
    return { expDir: dir, exp };
  }
  const recorded = (paths: Record<string, string>, sha = "a".repeat(64)) => () => ({ taskMaterialHash: sha, taskMaterialHashes: paths });

  it("recorded task material is read from the verified manifests, never from experiment.json", () => {
    const { expDir, exp } = experiment(tmp("cont-tm-"), recorded(TM()));
    writeFileSync(join(expDir, "experiment.json"), JSON.stringify({ ...exp, taskMaterialHash: "b".repeat(64) }));
    const r = experimentTaskMaterial(expDir, "1");
    expect(r).toEqual({ ok: true, sha256: "a".repeat(64), paths: TM(), source: "manifest" });
  });
  it("disagreeing, mixed or incomplete manifest metadata is UNVERIFIED", () => {
    const disagree = experiment(tmp("cont-tm-dis-"), (task, repeat) => ({ taskMaterialHash: task === "T-4" && repeat === 3 ? "c".repeat(64) : "a".repeat(64), taskMaterialHashes: TM() }));
    expect(experimentTaskMaterial(disagree.expDir, "1")).toMatchObject({ ok: false, problem: expect.stringMatching(/observations disagree on task material/) });
    const mixed = experiment(tmp("cont-tm-mix-"), (task) => (task === "T-3" ? {} : { taskMaterialHash: "a".repeat(64), taskMaterialHashes: TM() }));
    expect(experimentTaskMaterial(mixed.expDir, "1")).toMatchObject({ ok: false, problem: expect.stringMatching(/some observations record task material and some do not/) });
    const partial = TM(); delete partial["test/fixtures/continuity/rubric.md"];
    const incomplete = experiment(tmp("cont-tm-inc-"), recorded(partial));
    expect(experimentTaskMaterial(incomplete.expDir, "1")).toMatchObject({ ok: false, problem: expect.stringMatching(/per-path task material is incomplete/) });
    // Checksums prove the manifest's bytes, not that its fields are hashes: empty, truncated or non-hex values are refused.
    for (const [name, bad] of [["empty", ""], ["short", "a".repeat(63)], ["upper", "A".repeat(64)], ["non-hex", "g".repeat(64)]] as const) {
      const rolled = experiment(tmp(`cont-tm-bad-${name}-`), recorded(TM(), bad));
      expect(experimentTaskMaterial(rolled.expDir, "1")).toMatchObject({ ok: false, problem: expect.stringMatching(/per-path task material is incomplete or not SHA-256/) });
      const perPath = experiment(tmp(`cont-tm-badp-${name}-`), recorded(TM({ "test/fixtures/continuity/core": bad })));
      expect(experimentTaskMaterial(perPath.expDir, "1")).toMatchObject({ ok: false, problem: expect.stringMatching(/per-path task material is incomplete or not SHA-256/) });
    }
  });
  it("a side with any verification failure or no observations is UNVERIFIED, even when the rest match", () => {
    const { expDir } = experiment(tmp("cont-tm-fail-"), recorded(TM()));
    writeFileSync(join(expDir, "T-4", "repeat-3", "attempt-001", "manifest.json"), "tampered");
    const r = experimentTaskMaterial(expDir, "1");
    expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/1 verification failure\(s\): T-4#3/) });
    const empty = experiment(tmp("cont-tm-empty-"), recorded(TM()), []);
    expect(experimentTaskMaterial(empty.expDir, "1")).toMatchObject({ ok: false });
    expect((experimentTaskMaterial(empty.expDir, "1") as { problem: string }).problem).toMatch(/verification failure|no verified observations/);
  });
  it("compare passes identical material, and refuses a differing path naming it with both values, or an unverified side", () => {
    const a: TaskMaterialResult = { ok: true, sha256: "a".repeat(64), paths: TM(), source: "manifest" };
    expect(compareTaskMaterial(a, { ...a, source: "git ea3ca8eca8d1" })).toEqual({ ok: true, differing: [], problem: null });
    const b: TaskMaterialResult = { ok: true, sha256: "d".repeat(64), paths: TM({ "test/fixtures/continuity/rubric.md": "2".repeat(64) }), source: "manifest" };
    expect(compareTaskMaterial(a, b)).toEqual({ ok: false, differing: [{ label: "test/fixtures/continuity/rubric.md", baseline: "1".repeat(64), candidate: "2".repeat(64) }], problem: null });
    // Same per-path values under a different rolled value is still refused (the rolled value is the gate).
    expect(compareTaskMaterial(a, { ...a, sha256: "d".repeat(64) }).ok).toBe(false);
    // And the same rolled value over a differing per-path map (a hand-edited manifest) is refused, naming the path.
    expect(compareTaskMaterial(a, { ...b, sha256: a.sha256 })).toEqual({ ok: false, differing: [{ label: "test/fixtures/continuity/rubric.md", baseline: "1".repeat(64), candidate: "2".repeat(64) }], problem: null });
    expect(compareTaskMaterial(a, { ok: false, problem: "no verified observations" })).toEqual({ ok: false, differing: [], problem: "candidate: no verified observations" });
    expect(compareTaskMaterial({ ok: false, problem: "x" }, a)).toEqual({ ok: false, differing: [], problem: "baseline: x" });
  });
  it("the report header states the task material, or that it is unverified", () => {
    const { expDir, exp } = experiment(tmp("cont-tm-rep-"), recorded(TM()));
    const { observations, failures } = selectObservations(expDir, exp, "1");
    const text = renderReport(exp, aggregate(observations), observations, failures, "1", taskMaterialOf(observations));
    expect(text).toContain(`Task material: ${"a".repeat(64)} (manifest).`);
    expect(renderReport(exp, aggregate(observations), observations, failures, "1", { ok: false, problem: "p" })).toContain("Task material: UNVERIFIED (p).");
  });
  it("a legacy capture derives its task material from git at the verified head, only when the whole input tree reproduces the recorded inputTreeHash", () => {
    const repo = tmp("cont-tm-git-");
    const pkg = join(repo, "storybloq");
    const fx = join(pkg, "test", "fixtures", "continuity");
    mkdirSync(join(fx, "core", ".story"), { recursive: true }); mkdirSync(join(fx, "variants")); mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(fx, "core", ".story", "config.json"), "{}"); writeFileSync(join(fx, "variants", "T-2.a.json"), "{}");
    writeFileSync(join(fx, "facts.json"), "{}"); writeFileSync(join(fx, "fixture-map.json"), "{}"); writeFileSync(join(fx, "rubric.md"), "rubricVersion: 1\n");
    writeFileSync(join(pkg, "src", "x.ts"), "export const x = 1;\n"); writeFileSync(join(pkg, "package.json"), "{}\n");
    git(repo, ["init", "-q", "-b", "main"]); git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", "fixture"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const ith = hashInputs(INPUT_PATHS.map((p) => ({ label: p, path: join(pkg, p) })));
    const expected = taskMaterial(pkg);
    // The working tree moves on after the capture: the derivation must read the head, not the checkout.
    writeFileSync(join(fx, "rubric.md"), "rubricVersion: 2\n");
    const legacy = (headRec: string, ithRec: string) => experiment(tmp("cont-tm-leg-"), () => ({ inputTreeHash: ithRec, build: { storybloqVersion: "1.15.9", workspaceHead: headRec } }));
    const ok = legacy(head, ith);
    expect(experimentTaskMaterial(ok.expDir, "1", { pkgRoot: pkg })).toEqual({ ok: true, sha256: expected.sha256, paths: expected.paths, source: `git ${head.slice(0, 12)}, matches recorded inputTreeHash; preflight provenance` });
    const mismatch = legacy(head, "0".repeat(64));
    expect(experimentTaskMaterial(mismatch.expDir, "1", { pkgRoot: pkg })).toMatchObject({ ok: false, problem: expect.stringMatching(/does not reproduce the recorded inputTreeHash/) });
    const unknown = legacy("deadbeef".repeat(5), ith);
    expect(experimentTaskMaterial(unknown.expDir, "1", { pkgRoot: pkg })).toMatchObject({ ok: false, problem: expect.stringMatching(/not recorded and not derivable from git at deadbeefdead/) });
    const split = experiment(tmp("cont-tm-split-"), (task) => ({ inputTreeHash: ith, build: { storybloqVersion: "1.15.9", workspaceHead: task === "T-3" ? "f".repeat(40) : head } }));
    expect(experimentTaskMaterial(split.expDir, "1", { pkgRoot: pkg })).toMatchObject({ ok: false, problem: expect.stringMatching(/observations disagree on workspaceHead or inputTreeHash/) });
    const blank = legacy(head, "");
    expect(experimentTaskMaterial(blank.expDir, "1", { pkgRoot: pkg })).toMatchObject({ ok: false, problem: expect.stringMatching(/or do not record them/) });
  });
});
