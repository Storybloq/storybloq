/**
 * T-538 commit 1 (ISS-1463): the launch policy for a headless Claude turn, shared so continuity-run.ts can
 * adopt it (ISS-1486). A turn never carries a bypass: permissions are `dontAsk` with explicit allow rules,
 * Claude Code's sandbox writes only to the attempt's roots, and only user and flag settings are sources.
 *
 * Four parts, each the plan's section 4:
 *   4.1 `claudePolicySettings`: the policy file's exact text.
 *   4.2 `claudeTurnArgs`: the exact argv; the prompt travels on stdin, never on the command line.
 *   4.3 `claudeArgvProblems` and `policyFileProblems`: the refusal before every spawn.
 *   4.4 `claudeReadback` and `readbackProblems`: the effective settings, read back in the same process
 *       before the prompt is written. A policy file that does not load is silently ignored by the client
 *       (measured), so only the effective settings show what is in force.
 */
import { closeSync, constants as fsConstants, lstatSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { readBounded } from "./onboarding-eval-walk.js";

/** What every check of a Claude turn compares against. `project` is the one workspace directory the readback expects. */
export interface ClaudeExpected {
  readonly model: string;
  readonly policyFile: string;
  readonly policySha256: string;
  readonly mcpFile: string;
  readonly mcpSha256: string;
  readonly project: string;
  readonly roots: readonly string[];
  /** The storybloq tool names (bare) the policy allows: every name either project state may advertise. */
  readonly allowedTools: readonly string[];
  /** The storybloq tool names (bare) the server is expected to advertise at this launch, by the project's state. */
  readonly mcpTools: readonly string[];
  /** The MCP file's one server launch, which mcp_status must report. */
  readonly mcpLaunch: { readonly command: string; readonly args: readonly string[] };
  readonly maxBudgetUsd: number;
}

export type ClaudeSession = { readonly kind: "first" | "resume"; readonly id: string };

/** Built-in tools a turn may use, in the order the argv names them. */
export const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill"] as const;
/** The built-in tools the init event must report, sorted (measured names). */
export const CLAUDE_INIT_TOOLS = ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write"] as const;
/** Every spelling of a bypass that must never reach a client. */
export const CLAUDE_BYPASS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--restricted", "bypassPermissions"] as const;
/** The user settings file provisionClaude writes, the one `userSettings` source the readback expects. */
export const CLAUDE_USER_SETTINGS = { env: {}, hooks: {} } as const;

/** The policy object of 4.1, keys in the plan's order. */
export function claudePolicyObject(roots: readonly string[], mcpTools: readonly string[]): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: "dontAsk",
      allow: ["Read", "Glob", "Grep", "Bash", "Skill", ...roots.map((r) => `Edit(/${r}/**)`), ...mcpTools.map((t) => `mcp__storybloq__${t}`)],
      deny: ["WebFetch", "WebSearch", "Agent", "Task"],
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: { allowWrite: [...roots] },
      network: { allowedDomains: [], strictAllowlist: true },
    },
    env: {},
    hooks: {},
  };
}

/** 4.1: the policy file's exact text. Roots are absolute, so `Edit(/<root>/**)` is the `//abs/**` form. */
export function claudePolicySettings(roots: readonly string[], mcpTools: readonly string[]): string {
  for (const r of roots) if (!r.startsWith("/")) throw new Error(`headless-policy: root ${r} is not absolute`);
  return `${JSON.stringify(claudePolicyObject(roots, mcpTools), null, 2)}\n`;
}

/** 4.2: the exact argv of one turn, in order. No prompt argument and no `--`. */
export function claudeTurnArgs(e: ClaudeExpected, session: ClaudeSession): string[] {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", e.model, "--tools", CLAUDE_TOOLS.join(","), "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--setting-sources", "user", "--settings", e.policyFile, "--strict-mcp-config", "--mcp-config", e.mcpFile,
    "--max-budget-usd", String(e.maxBudgetUsd),
    ...(session.kind === "first" ? ["--session-id", session.id] : ["--resume", session.id]),
  ];
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;

/**
 * 4.3: everything in `args` that is not exactly 4.2's sequence; empty means it holds. Each option exactly
 * once in any order with its expected value, no `=` form, no `--`, nothing else.
 */
export function claudeArgvProblems(args: readonly string[], e: ClaudeExpected, session: ClaudeSession): string[] {
  const flags = new Set(["-p", "--verbose", "--strict-mcp-config"]);
  const valued: Record<string, string> = {
    "--input-format": "stream-json", "--output-format": "stream-json", "--model": e.model, "--tools": CLAUDE_TOOLS.join(","),
    "--permission-mode": "dontAsk", "--permission-prompts": "none", "--setting-sources": "user", "--settings": e.policyFile,
    "--mcp-config": e.mcpFile, "--max-budget-usd": String(e.maxBudgetUsd), "--session-id": session.id, "--resume": session.id,
  };
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const values = new Map<string, string>();
  // A bypass spelling is refused wherever it stands, an option's value included (plan 4.3: smuggled as the model).
  for (const a of args) if ((CLAUDE_BYPASS as readonly string[]).includes(a)) problems.push(`${a} is a bypass spelling`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { problems.push("-- is refused: nothing follows the options"); continue; }
    if (a.startsWith("-") && a.includes("=")) { problems.push(`${a} is refused: no = form`); continue; }
    if (flags.has(a)) { seen.set(a, (seen.get(a) ?? 0) + 1); continue; }
    if (Object.hasOwn(valued, a)) {
      seen.set(a, (seen.get(a) ?? 0) + 1);
      const v = args[i + 1];
      if (v === undefined) { problems.push(`${a} has no value`); continue; }
      i += 1;
      if (!values.has(a)) values.set(a, v);
      else if (values.get(a) !== v) values.set(a, `${values.get(a)}\u0000${v}`);
      continue;
    }
    problems.push(`${a} is refused`);
  }
  for (const [k, n] of seen) if (n > 1) problems.push(`${k} appears ${n} times`);
  for (const f of flags) if (!seen.has(f)) problems.push(`${f} is missing`);
  const want = session.kind === "first" ? "--session-id" : "--resume";
  const other = session.kind === "first" ? "--resume" : "--session-id";
  if (seen.has(other)) problems.push(`${other} is refused for a ${session.kind} turn`);
  for (const [k, expected] of Object.entries(valued)) {
    if (k === other) continue;
    const got = values.get(k);
    if (got === undefined) { if (!(seen.get(k) ?? 0)) problems.push(`${k} is missing`); continue; }
    if (got !== expected) problems.push(`${k} ${got.replace(/\u0000/g, " / ")} is not ${expected}`);
  }
  const model = values.get("--model");
  if (model !== undefined && !MODEL.test(model)) problems.push(`--model ${model} is not a model name`);
  const budget = values.get("--max-budget-usd");
  if (budget !== undefined && (!DECIMAL.test(budget) || !Number.isFinite(Number(budget)) || Number(budget) <= 0)) problems.push(`--max-budget-usd ${budget} is not a finite positive decimal`);
  if (!Number.isFinite(e.maxBudgetUsd) || e.maxBudgetUsd <= 0) problems.push(`the expected budget ${e.maxBudgetUsd} is not a finite positive number`);
  const id = values.get(want);
  if (id !== undefined && !UUID.test(id)) problems.push(`${want} ${id} is not a lowercase UUID`);
  return problems;
}

/** The most bytes a policy or MCP file may have; either is a few KiB. */
export const POLICY_FILE_LIMIT = 1 << 20;

/**
 * 4.3: why the file at `path` is not the one recorded: not a regular file (a link included), another mode,
 * another owner, or other bytes. A replacement with the same bytes, owner and mode is accepted.
 */
export function policyFileProblems(path: string, sha256: string, mode = 0o400): string[] {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); } catch (e) { return [`${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`]; }
  if (!st.isFile()) return [`${path} is not a regular file`];
  const problems: string[] = [];
  if ((st.mode & 0o7777) !== mode) problems.push(`${path} has mode ${(st.mode & 0o7777).toString(8)}, not ${mode.toString(8)}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) problems.push(`${path} is owned by uid ${st.uid}, not ${uid}`);
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (e) { return [...problems, `${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`]; }
  try {
    const r = readBounded(fd, POLICY_FILE_LIMIT);
    if ("code" in r) problems.push(`${path}: ${r.code}`);
    else if ("over" in r) problems.push(`${path} is over ${r.over} bytes`);
    else if (createHash("sha256").update(r.bytes).digest("hex") !== sha256) problems.push(`${path} is not the recorded bytes`);
  } finally {
    closeSync(fd);
  }
  return problems;
}

// --- 4.4 the readback ----------------------------------------------------------------

/** The control requests, in the order they are sent. */
export const READBACK_REQUESTS = ["initialize", "get_settings", "get_sandbox_dialog", "list_permission_rules", "mcp_status", "get_hooks_listing"] as const;
export type ReadbackSubtype = (typeof READBACK_REQUESTS)[number];
export const READBACK_TIMEOUT_MS = 30_000;

/** One request and what came back: the response's inner object, an error, or nothing by the deadline. */
export interface ReadbackStep {
  readonly requestId: string;
  readonly subtype: ReadbackSubtype;
  readonly outcome: "success" | "error" | "timeout";
  readonly response?: unknown;
  readonly error?: string;
}

/** What the readback compares against: also what a host-v2 record stores for the regrade. */
export interface ReadbackExpected {
  readonly project: string;
  readonly roots: readonly string[];
  readonly policy: Record<string, unknown>;
  readonly mcpTools: readonly string[];
  readonly mcpLaunch: { readonly command: string; readonly args: readonly string[] };
}

export const readbackExpected = (e: ClaudeExpected): ReadbackExpected => ({
  project: e.project, roots: [...e.roots], policy: claudePolicyObject(e.roots, e.allowedTools), mcpTools: [...e.mcpTools], mcpLaunch: { command: e.mcpLaunch.command, args: [...e.mcpLaunch.args] },
});

/** JSON with object keys sorted, so equal values have equal text. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => same([...a].sort(), [...b].sort());
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const isEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : obj(v) !== null && Object.keys(obj(v)!).length === 0);

/** An API key source as `initialize` names one; anything else (an OAuth token, "none") is not. */
const API_KEY_SOURCE = /api|key/i;

/** The sandbox restrictions the dialog must report, field by field. */
export function expectedRestrictions(roots: readonly string[]): Record<string, unknown> {
  return {
    fs_deny_read: [], fs_allow_read: [], fs_allow_write: [...roots], fs_deny_write: [], network_allowed_domains: [], network_denied_domains: [],
    network_managed: false, unix_sockets: [], allow_all_unix_sockets: false, ignored_glob_patterns: [],
  };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === "string");

/** What makes the stored exchange or the expected values unusable, before any comparison reads them. */
function readbackShapeProblems(steps: unknown, x: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(steps)) problems.push("readback.steps is not a list");
  else {
    const seen = new Set<string>();
    steps.forEach((v, i) => {
      const s = obj(v);
      const ok = s !== null && typeof s.requestId === "string" && typeof s.subtype === "string" && (READBACK_REQUESTS as readonly string[]).includes(s.subtype)
        && (s.outcome === "success" || s.outcome === "error" || s.outcome === "timeout");
      if (!ok) { problems.push(`readback.steps[${i}] is malformed`); return; }
      if (seen.has(s.subtype as string)) problems.push(`readback.steps[${i}] repeats ${String(s.subtype)}`);
      seen.add(s.subtype as string);
    });
  }
  const e = obj(x);
  const permissions = obj(obj(e?.policy)?.permissions);
  if (e === null || typeof e.project !== "string" || !isStrings(e.roots) || !isStrings(e.mcpTools)) problems.push("readback.expected is malformed");
  else if (permissions === null || !isStrings(permissions.allow) || !isStrings(permissions.deny)) problems.push("readback.expected.policy.permissions is malformed");
  else {
    const launch = obj(e.mcpLaunch);
    if (launch === null || typeof launch.command !== "string" || !isStrings(launch.args)) problems.push("readback.expected.mcpLaunch is malformed");
  }
  return problems;
}

/**
 * 4.4: every way the exchange differs from what this launch must have in force, in request order. The first
 * entry names the field of the infrastructure failure `launch: <field>`. Pure, so the regrade re-runs it on
 * the stored exchange against the record's expected values.
 */
export function readbackProblems(steps: readonly ReadbackStep[], x: ReadbackExpected): string[] {
  // The regrade feeds stored JSON here, so the shapes are checked first: a malformed input is a named refusal, never a throw.
  const shape = readbackShapeProblems(steps, x);
  if (shape.length > 0) return shape;
  const problems: string[] = [];
  const at = new Map(steps.map((s) => [s.subtype, s]));
  const body = (sub: ReadbackSubtype): Record<string, unknown> | null => {
    const s = at.get(sub);
    if (s === undefined) { problems.push(`${sub}: no response`); return null; }
    if (s.outcome === "timeout") { problems.push(`${sub}: no response within ${READBACK_TIMEOUT_MS} ms`); return null; }
    if (s.outcome === "error") { problems.push(`${sub}: error response`); return null; }
    const o = obj(s.response);
    if (o === null) { problems.push(`${sub}: the response is not an object`); return null; }
    return o;
  };
  const policy = x.policy as { permissions: { allow: string[]; deny: string[] } };

  const init = body("initialize");
  if (init !== null) {
    if (init.current_permission_mode !== "dontAsk") problems.push("initialize.current_permission_mode");
    const account = obj(init.account);
    const source = account?.tokenSource;
    // Addendum A: until the probe turn pins the live value, any source naming an API key is refused.
    if (typeof source !== "string" || (source !== "none" && API_KEY_SOURCE.test(source))) problems.push("initialize.account.tokenSource");
    if (account?.apiProvider !== "firstParty") problems.push("initialize.account.apiProvider");
  }

  const settings = body("get_settings");
  if (settings !== null) {
    const sources = settings.sources;
    const want = [{ source: "userSettings", settings: CLAUDE_USER_SETTINGS }, { source: "flagSettings", settings: x.policy }];
    const got = Array.isArray(sources) ? sources.map((s) => ({ source: obj(s)?.source, settings: obj(s)?.settings })) : null;
    if (got === null || got.length !== want.length || !want.every((w) => got.some((g) => same(g, w)))) problems.push("get_settings.sources");
  }

  const dialog = body("get_sandbox_dialog");
  if (dialog !== null) {
    // Addendum A: with the policy file in force the dialog is locked (4.4 said otherwise; measured).
    if (dialog.supported !== true) problems.push("get_sandbox_dialog.supported");
    if (dialog.enabled !== true) problems.push("get_sandbox_dialog.enabled");
    if (dialog.enabled_in_settings !== true) problems.push("get_sandbox_dialog.enabled_in_settings");
    if (dialog.locked !== true) problems.push("get_sandbox_dialog.locked");
    if (dialog.overrides_locked !== true) problems.push("get_sandbox_dialog.overrides_locked");
    if (dialog.unsandboxed_fallback !== false) problems.push("get_sandbox_dialog.unsandboxed_fallback");
    if (!isEmpty(dialog.policy_origins)) problems.push("get_sandbox_dialog.policy_origins");
    if (!isEmpty(dialog.excluded_commands)) problems.push("get_sandbox_dialog.excluded_commands");
    if (!isEmpty(obj(dialog.dependencies)?.errors)) problems.push("get_sandbox_dialog.dependencies.errors");
    if (!same(dialog.restrictions, expectedRestrictions(x.roots))) problems.push("get_sandbox_dialog.restrictions");
  }

  const rules = body("list_permission_rules");
  if (rules !== null) {
    const state = obj(rules.state);
    const list = Array.isArray(state?.rules) ? (state!.rules as unknown[]) : null;
    const want = [...policy.permissions.allow.map((r) => ({ rule: r, behavior: "allow", source: "flagSettings" })), ...policy.permissions.deny.map((r) => ({ rule: r, behavior: "deny", source: "flagSettings" }))];
    const got = list === null ? null : list.map(obj).filter((r) => r?.source !== "toolsNarrowing").map((r) => ({ rule: r?.rule, behavior: r?.behavior, source: r?.source }));
    if (got === null || !same([...got].map(canon).sort(), want.map(canon).sort())) problems.push("list_permission_rules.state.rules");
    if (state?.managedOnly !== false) problems.push("list_permission_rules.state.managedOnly");
    // Addendum A: the project is the original cwd and no other workspace directory is added.
    if (!same(state?.workspaceDirectories, [])) problems.push("list_permission_rules.state.workspaceDirectories");
    if (state?.originalCwd !== x.project) problems.push("list_permission_rules.state.originalCwd");
  }

  const mcp = body("mcp_status");
  if (mcp !== null) {
    const servers = Array.isArray(mcp.mcpServers) ? mcp.mcpServers.map(obj) : null;
    const one = servers !== null && servers.length === 1 ? servers[0] : null;
    if (one?.name !== "storybloq" || one?.status !== "connected") problems.push("mcp_status.mcpServers");
    else {
      const config = obj(one.config);
      if (config?.command !== x.mcpLaunch.command || !same(config?.args, x.mcpLaunch.args)) problems.push("mcp_status.mcpServers.config");
      const tools = Array.isArray(one.tools) ? one.tools.map((t) => obj(t)?.name) : null;
      if (tools === null || tools.some((t) => typeof t !== "string") || !sameSet(tools as string[], x.mcpTools)) problems.push("mcp_status.mcpServers.tools");
    }
  }

  const hooks = body("get_hooks_listing");
  if (hooks !== null) {
    if (!Array.isArray(hooks.events) || hooks.events.length !== 0) problems.push("get_hooks_listing.events");
    if (!Array.isArray(hooks.hooks) || hooks.hooks.length !== 0) problems.push("get_hooks_listing.hooks");
    const hp = obj(hooks.policy);
    if (hp?.policyHookCount !== 0) problems.push("get_hooks_listing.policy.policyHookCount");
    if (hp?.disabledByPolicy !== false) problems.push("get_hooks_listing.policy.disabledByPolicy");
    if (hp?.managedOnly !== false) problems.push("get_hooks_listing.policy.managedOnly");
  }
  return problems;
}

/** The transport the readback runs over: one line out, and the response to one request id, or null at the deadline. */
export interface ReadbackIo {
  write(line: string): void;
  response(requestId: string, timeoutMs: number): Promise<{ readonly subtype: string; readonly response?: unknown; readonly error?: unknown } | null>;
}

/** The control request line for `rN`. */
export const controlRequest = (requestId: string, subtype: ReadbackSubtype): string => `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype } })}\n`;

/** The user message line that carries the prompt (4.4). */
export const userMessage = (prompt: string): string => `${JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" })}\n`;

/**
 * 4.4: sends r1..r6 in order, each awaited (30 s) before the next, and compares the exchange. The prompt is
 * the caller's to write, and only when `problems` is empty.
 */
export async function claudeReadback(io: ReadbackIo, x: ReadbackExpected, timeoutMs = READBACK_TIMEOUT_MS): Promise<{ readonly steps: readonly ReadbackStep[]; readonly problems: readonly string[] }> {
  const steps: ReadbackStep[] = [];
  for (const [i, subtype] of READBACK_REQUESTS.entries()) {
    const requestId = `r${i + 1}`;
    io.write(controlRequest(requestId, subtype));
    const r = await io.response(requestId, timeoutMs);
    if (r === null) { steps.push({ requestId, subtype, outcome: "timeout" }); break; }
    if (r.subtype !== "success") { steps.push({ requestId, subtype, outcome: "error", error: String(r.error ?? r.subtype) }); break; }
    steps.push({ requestId, subtype, outcome: "success", response: r.response });
  }
  return { steps, problems: readbackProblems(steps, x) };
}

/**
 * Whether a turn's init event is consulted, given the failure the turn records without it and its exit code.
 * One predicate for the runner and the regrade: exit 0 and no failure, a launch failure, a terminal failure or
 * a cleanup failure. By the failure order (spawn, launch, input, timed out, killed by, exit, terminal, cleanup)
 * each of those four implies the run was not timed out, not signalled and exited 0. An input failure means the
 * prompt was never delivered, so the init event says nothing about it and is never consulted.
 */
export function initEventConsulted(failure: string | null, exitCode: number | null): boolean {
  if (exitCode !== 0) return false;
  return failure === null || failure.startsWith("launch: ") || failure.startsWith("terminal ") || failure.startsWith("cleanup: ");
}

/**
 * 4.4: the stream's first system init event: permission mode, API key source, the one MCP server, and the
 * built-in tools exactly; every `mcp__` tool belongs to storybloq and is expected. Empty means it holds.
 */
export function initEventProblems(events: readonly Record<string, unknown>[], mcpTools: readonly string[]): string[] {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  if (init === undefined) return ["init: no system init event"];
  const problems: string[] = [];
  if (init.permissionMode !== "dontAsk") problems.push("init.permissionMode");
  if (init.apiKeySource !== "none") problems.push("init.apiKeySource");
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s) => ({ name: obj(s)?.name, status: obj(s)?.status })) : null;
  if (!same(servers, [{ name: "storybloq", status: "connected" }])) problems.push("init.mcp_servers");
  const tools = Array.isArray(init.tools) ? init.tools.map(String) : [];
  const builtIn = tools.filter((t) => !t.startsWith("mcp__"));
  if (!same([...builtIn].sort(), [...CLAUDE_INIT_TOOLS])) problems.push("init.tools");
  const prefix = "mcp__storybloq__";
  if (tools.some((t) => t.startsWith("mcp__") && (!t.startsWith(prefix) || !mcpTools.includes(t.slice(prefix.length))))) problems.push("init.tools.mcp");
  return problems;
}
