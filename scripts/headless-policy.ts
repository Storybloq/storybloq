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
  /** The MCP file's one server launch, which mcp_status must report. `env`, when given, is compared too (ISS-1486 D3). */
  readonly mcpLaunch: McpLaunch;
  readonly maxBudgetUsd: number;
  /** T-525 Addendum E3: a signed-in launch's pinned provenance listings; absent on every other launch. */
  readonly provenance?: SignedInProvenance;
}

/**
 * T-525 Addendum E3: what a signed-in launch's provenance listings must be, bound to one client version. A
 * required input of every signed-in launch with no production default; the empty sets are test fixtures only.
 */
export interface SignedInProvenance {
  readonly clientVersion: string;
  readonly agents: readonly string[];
  readonly commands: readonly string[];
  readonly skills: readonly string[];
  readonly plugins: readonly string[];
  readonly outputStyle: string;
}

/** The MCP file's one server launch. The onboarding runner gives no `env`; the continuity runner pins its project root. */
export interface McpLaunch { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> }

export type ClaudeSession = { readonly kind: "first" | "resume"; readonly id: string };

/** Built-in tools a turn may use, in the order the argv names them. */
export const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill"] as const;
/** The onboarding built-in tools the init event must report, sorted (measured names); the init check sorts the options' own list. */
export const CLAUDE_INIT_TOOLS = ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write"] as const;
/** Every spelling of a bypass that must never reach a client. */
export const CLAUDE_BYPASS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--restricted", "bypassPermissions"] as const;
/** The user settings file provisionClaude writes, the one `userSettings` source the readback expects. */
export const CLAUDE_USER_SETTINGS = { env: {}, hooks: {} } as const;

/**
 * ISS-1486 D1: what differs between the runners that share this policy. The allow list is written out per runner,
 * never derived from the tool list; `Edit(/<root>/**)` rules still come only from the roots. `extraArgs` are
 * valued options and `extraFlags` bare ones, each placed after `--max-budget-usd` and checked exactly once.
 */
export interface ClaudePolicyOptions {
  /** The built-in tools the argv names, in order. */
  readonly builtInTools: readonly string[];
  /** The built-in tools the policy allows, in order, before the Edit rules. */
  readonly allowBuiltIns: readonly string[];
  readonly deny: readonly string[];
  readonly extraArgs: readonly (readonly [string, string])[];
  readonly extraFlags: readonly string[];
  /**
   * T-525 Addendum E2: which settings sources the client loads besides the run's --settings file. Absent or
   * "user" is the T-538 contract (the provisioned user settings plus flagSettings); "none" passes
   * `--setting-sources ""`, so the readback must show flagSettings alone.
   */
  readonly settingSources?: "user" | "none";
}

const settingSourcesArg = (o: ClaudePolicyOptions): string => (o.settingSources === "none" ? "" : "user");

/** The onboarding runner's options: exactly the constants of T-538 commit 1, so its policy, argv and readback are unchanged. */
export const ONBOARDING_OPTIONS: ClaudePolicyOptions = Object.freeze({
  builtInTools: CLAUDE_TOOLS,
  allowBuiltIns: Object.freeze(["Read", "Glob", "Grep", "Bash", "Skill"]),
  deny: Object.freeze(["WebFetch", "WebSearch", "Agent", "Task"]),
  extraArgs: Object.freeze([]),
  extraFlags: Object.freeze([]),
});

/** The options the base argv check owns; an extra may never reuse one. */
const BASE_OPTIONS = ["-p", "--verbose", "--strict-mcp-config", "--input-format", "--output-format", "--model", "--tools", "--permission-mode", "--permission-prompts",
  "--setting-sources", "--settings", "--mcp-config", "--max-budget-usd", "--session-id", "--resume"] as const;
const EXTRA_NAME = /^--[a-z][a-z0-9-]*$/;

/** Why an options value cannot build a launch: an extra that is not a plain long option, reuses a base option or repeats, or a bypass anywhere. */
export function policyOptionsProblems(o: ClaudePolicyOptions): string[] {
  const problems: string[] = [];
  const names = [...o.extraArgs.map(([k]) => k), ...o.extraFlags];
  const seen = new Set<string>();
  for (const k of names) {
    if (!EXTRA_NAME.test(k)) problems.push(`options: ${k} is not a plain long option`);
    if ((BASE_OPTIONS as readonly string[]).includes(k)) problems.push(`options: ${k} is a base option`);
    if (seen.has(k)) problems.push(`options: ${k} is given twice`);
    seen.add(k);
  }
  for (const v of [...names, ...o.extraArgs.map(([, v]) => v), ...o.builtInTools, ...o.allowBuiltIns]) {
    if ((CLAUDE_BYPASS as readonly string[]).includes(v)) problems.push(`options: ${v} is a bypass spelling`);
  }
  for (const t of o.allowBuiltIns) if (o.deny.includes(t)) problems.push(`options: ${t} is both allowed and denied`);
  if (o.settingSources !== undefined && o.settingSources !== "user" && o.settingSources !== "none") problems.push(`options: settingSources ${String(o.settingSources)} is neither "user" nor "none"`);
  return problems;
}

function checkedOptions(o: ClaudePolicyOptions): ClaudePolicyOptions {
  const problems = policyOptionsProblems(o);
  if (problems.length > 0) throw new Error(`headless-policy: ${problems.join("; ")}`);
  return o;
}

/** The policy object of 4.1, keys in the plan's order. */
export function claudePolicyObject(roots: readonly string[], mcpTools: readonly string[], o: ClaudePolicyOptions = ONBOARDING_OPTIONS): Record<string, unknown> {
  checkedOptions(o);
  return {
    permissions: {
      defaultMode: "dontAsk",
      allow: [...o.allowBuiltIns, ...roots.map((r) => `Edit(/${r}/**)`), ...mcpTools.map((t) => `mcp__storybloq__${t}`)],
      deny: [...o.deny],
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
export function claudePolicySettings(roots: readonly string[], mcpTools: readonly string[], o: ClaudePolicyOptions = ONBOARDING_OPTIONS): string {
  for (const r of roots) if (!r.startsWith("/")) throw new Error(`headless-policy: root ${r} is not absolute`);
  return `${JSON.stringify(claudePolicyObject(roots, mcpTools, o), null, 2)}\n`;
}

/** 4.2: the exact argv of one turn, in order. No prompt argument and no `--`. */
export function claudeTurnArgs(e: ClaudeExpected, session: ClaudeSession, o: ClaudePolicyOptions = ONBOARDING_OPTIONS): string[] {
  checkedOptions(o);
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", e.model, "--tools", o.builtInTools.join(","), "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--setting-sources", settingSourcesArg(o), "--settings", e.policyFile, "--strict-mcp-config", "--mcp-config", e.mcpFile,
    "--max-budget-usd", String(e.maxBudgetUsd),
    ...o.extraArgs.flatMap(([k, v]) => [k, v]), ...o.extraFlags,
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
export function claudeArgvProblems(args: readonly string[], e: ClaudeExpected, session: ClaudeSession, o: ClaudePolicyOptions = ONBOARDING_OPTIONS): string[] {
  const optionProblems = policyOptionsProblems(o);
  if (optionProblems.length > 0) return optionProblems;
  const flags = new Set(["-p", "--verbose", "--strict-mcp-config", ...o.extraFlags]);
  // Built from entries, so every key is an own property (a `__proto__` name could never reach the prototype).
  const valued: Record<string, string> = Object.fromEntries([
    ["--input-format", "stream-json"], ["--output-format", "stream-json"], ["--model", e.model], ["--tools", o.builtInTools.join(",")],
    ["--permission-mode", "dontAsk"], ["--permission-prompts", "none"], ["--setting-sources", settingSourcesArg(o)], ["--settings", e.policyFile],
    ["--mcp-config", e.mcpFile], ["--max-budget-usd", String(e.maxBudgetUsd)], ["--session-id", session.id], ["--resume", session.id],
    ...o.extraArgs.map(([k, v]) => [k, v] as const),
  ]);
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
  readonly mcpLaunch: McpLaunch;
  /** E2: present only as "none"; absent keeps the user-plus-flag source contract. */
  readonly settingSources?: "none";
  /** E3 (B1): the pinned client version and listings; present, every readback must match them. Absent on fresh. */
  readonly provenance?: SignedInProvenance;
  /** E3 (B2): the per-turn request id namespace `t<nonce>-`; present exactly when provenance is. */
  readonly nonce?: string;
  /** E3 (B3): the launch is signed-in, so the memory refusal runs. Keyed on isolation, never on provenance. */
  readonly signedIn?: true;
}

export const readbackExpected = (e: ClaudeExpected, o: ClaudePolicyOptions = ONBOARDING_OPTIONS, turn: { readonly nonce?: string; readonly signedIn?: boolean } = {}): ReadbackExpected => ({
  project: e.project, roots: [...e.roots], policy: claudePolicyObject(e.roots, e.allowedTools, o), mcpTools: [...e.mcpTools],
  mcpLaunch: { command: e.mcpLaunch.command, args: [...e.mcpLaunch.args], ...(e.mcpLaunch.env === undefined ? {} : { env: { ...e.mcpLaunch.env } }) },
  ...(o.settingSources === "none" ? { settingSources: "none" as const } : {}),
  ...(e.provenance === undefined ? {} : { provenance: e.provenance, ...(turn.nonce === undefined ? {} : { nonce: turn.nonce }) }),
  ...(turn.signedIn === true ? { signedIn: true as const } : {}),
});

/** E3 (B2): the request id namespace for one turn's readback; empty (r1..r6) with no nonce. */
export const readbackNamespace = (nonce: string | undefined): string => (nonce === undefined ? "" : `t${nonce}-`);

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

/** A listing of typed names: every entry an object with a non-empty string name (spread, so a hole is an entry). */
function typedNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const names = [...v].map((t) => obj(t)?.name);
  return names.every((n): n is string => typeof n === "string" && n !== "") ? names : null;
}
/** A listing the init event carries: plain names, or typed names (plugins come as objects). */
function initNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const items = [...v];
  if (items.every((t) => typeof t === "string" && t !== "")) return items as string[];
  return typedNames(items);
}
const exactNames = (got: readonly string[], want: readonly string[]): boolean => new Set(got).size === got.length && sameSet(got, want);

/**
 * E3 (B1): the readback's initialize listings against the pin: the client version, and the agents and commands
 * exactly the run's own. Codes: provenance.version, provenance.listing-missing:<f>, provenance.malformed:<f>,
 * provenance.mismatch:<f>. Pure, so the regrade re-runs it.
 */
export function listingProblems(init: Record<string, unknown>, p: SignedInProvenance): string[] {
  const out: string[] = [];
  const version = init.claude_code_version;
  if (typeof version !== "string") out.push("provenance.version: missing");
  else if (version !== p.clientVersion) out.push("provenance.version: not the pinned version");
  for (const [f, want] of [["agents", p.agents], ["commands", p.commands]] as const) {
    if (init[f] === undefined) { out.push(`provenance.listing-missing:${f}`); continue; }
    const names = typedNames(init[f]);
    if (names === null) out.push(`provenance.malformed:${f}`);
    else if (!exactNames(names, want)) out.push(`provenance.mismatch:${f}`);
  }
  return out;
}

/** The init event's provenance fields, as the pin names them. */
const INIT_FIELDS = [["skills", "skills"], ["plugins", "plugins"], ["agents", "agents"], ["slash_commands", "commands"]] as const;

/**
 * E3 (B4): one system init event against the pin: skills, plugins, agents and slash commands exactly the run's own,
 * the output style and the client version equal. Codes: init.provenance:<field>. Pure.
 */
export function initProvenanceProblems(init: Record<string, unknown>, p: SignedInProvenance): string[] {
  const out: string[] = [];
  for (const [f, k] of INIT_FIELDS) {
    const names = initNames(init[f]);
    if (names === null || !exactNames(names, p[k])) out.push(`init.provenance:${f}`);
  }
  if (init.output_style !== p.outputStyle) out.push("init.provenance:output_style");
  if (init.claude_code_version !== p.clientVersion) out.push("init.provenance:claude_code_version");
  return out;
}

/**
 * E3 (B4): an init event that disagrees with the same turn's readback (its version, or its agents' names) is a
 * contradiction, whatever the pin says. False when the readback gave nothing to compare.
 */
export function initContradicts(init: Record<string, unknown>, readbackInit: Record<string, unknown> | null): boolean {
  if (readbackInit === null) return false;
  // Only a present, well-formed field can contradict; a missing or malformed one is the pin check's to name.
  if (typeof init.claude_code_version === "string" && init.claude_code_version !== readbackInit.claude_code_version) return true;
  const a = initNames(init.agents);
  const b = typedNames(readbackInit.agents);
  return a !== null && b !== null && !sameSet(a, b);
}

/** B-F1: a readback, init or cleanup problem that belongs to provenance, and so latches the non-retryable stop. */
export const isProvenanceProblem = (p: string): boolean => /^(provenance\.|memory\.|readback\.(stale|unsolicited)|init\.(provenance|missing|duplicate|contradiction)|cleanup\.unconfirmed)/.test(p);

/** The text of the memory refusal: the pinned client exposes no listing of the memory files it loaded. */
export const MEMORY_UNPROVEN = "memory.unproven: the pinned client lists no loaded memory files, so their exclusion is unproven";

const PROVENANCE_LISTS = ["agents", "commands", "skills", "plugins"] as const;
const PROVENANCE_KEYS: readonly string[] = ["clientVersion", ...PROVENANCE_LISTS, "outputStyle"];

/**
 * E3: the fields of a pinned provenance that are not what a signed-in launch needs: the client version and the
 * output style as non-empty strings, each listing as an array of distinct non-empty strings, and no other key.
 * Empty means it is well formed. B-F4: the one validator, for preparation and for a stored record's pin alike.
 */
export function provenanceProblems(p: unknown): string[] {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return ["provenance"];
  const v = p as Record<string, unknown>;
  const out: string[] = [];
  const text = (x: unknown): boolean => typeof x === "string" && x !== "";
  if (!text(v.clientVersion)) out.push("clientVersion");
  for (const k of PROVENANCE_LISTS) {
    const l = v[k];
    // Spread first: every() skips a hole, so a sparse listing would pass and serialise as null entries.
    if (!Array.isArray(l) || ![...l].every(text) || new Set(l).size !== l.length) out.push(k);
  }
  if (!text(v.outputStyle)) out.push("outputStyle");
  for (const k of Object.keys(v)) if (!PROVENANCE_KEYS.includes(k)) out.push(`unexpected ${k}`);
  return out;
}

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
    const env = launch?.env === undefined ? {} : obj(launch.env);
    if (launch === null || typeof launch.command !== "string" || !isStrings(launch.args) || env === null || !Object.values(env).every((v) => typeof v === "string")) problems.push("readback.expected.mcpLaunch is malformed");
    if (e.provenance !== undefined && provenanceProblems(e.provenance).length > 0) problems.push("readback.expected.provenance is malformed");
    if (e.nonce !== undefined && (typeof e.nonce !== "string" || !/^[0-9a-f]{12}$/.test(e.nonce))) problems.push("readback.expected.nonce is malformed");
    if (e.signedIn !== undefined && e.signedIn !== true) problems.push("readback.expected.signedIn is malformed");
  }
  return problems;
}

/**
 * 4.4: every way the exchange differs from what this launch must have in force, in request order. The first
 * entry names the field of the infrastructure failure `launch: <field>`. Pure, so the regrade re-runs it on
 * the stored exchange against the record's expected values.
 */
export function readbackProblems(steps: readonly ReadbackStep[], x: ReadbackExpected, memoryEvidence?: () => readonly string[]): string[] {
  // The regrade feeds stored JSON here, so the shapes are checked first: a malformed input is a named refusal, never a throw.
  const shape = readbackShapeProblems(steps, x);
  if (shape.length > 0) return shape;
  const problems: string[] = [];
  // E3 (B2): with provenance, every stored id carries this record's own nonce; anything else is another turn's exchange.
  if (x.provenance !== undefined) {
    const ns = readbackNamespace(x.nonce);
    if (x.nonce === undefined || steps.some((s, i) => s.requestId !== `${ns}r${i + 1}`)) problems.push("readback.stale: the exchange does not carry this turn's nonce");
  }
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
    if (x.provenance !== undefined) problems.push(...listingProblems(init, x.provenance));
  }

  const settings = body("get_settings");
  if (settings !== null) {
    const sources = settings.sources;
    // E2: with no user source, exactly one source remains, flagSettings holding the policy.
    const want = x.settingSources === "none"
      ? [{ source: "flagSettings", settings: x.policy }]
      : [{ source: "userSettings", settings: CLAUDE_USER_SETTINGS }, { source: "flagSettings", settings: x.policy }];
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
      if (config?.command !== x.mcpLaunch.command || !same(config?.args, x.mcpLaunch.args)
        || (x.mcpLaunch.env !== undefined && !same(config?.env, x.mcpLaunch.env))) problems.push("mcp_status.mcpServers.config");
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
  // E3 (B0 ii, B3): signed-in, memory is always unproven on the pinned client; the evidence only adds to the text.
  if (x.signedIn === true) {
    const evidence = memoryEvidence?.() ?? [];
    problems.push(evidence.length === 0 ? MEMORY_UNPROVEN : `${MEMORY_UNPROVEN} (${evidence.join("; ")})`);
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
  const ns = x.provenance === undefined ? "" : readbackNamespace(x.nonce);
  for (const [i, subtype] of READBACK_REQUESTS.entries()) {
    const requestId = `${ns}r${i + 1}`;
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
export function initEventProblems(events: readonly Record<string, unknown>[], mcpTools: readonly string[], o: ClaudePolicyOptions = ONBOARDING_OPTIONS): string[] {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  if (init === undefined) return ["init: no system init event"];
  const problems: string[] = [];
  if (init.permissionMode !== "dontAsk") problems.push("init.permissionMode");
  if (init.apiKeySource !== "none") problems.push("init.apiKeySource");
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s) => ({ name: obj(s)?.name, status: obj(s)?.status })) : null;
  if (!same(servers, [{ name: "storybloq", status: "connected" }])) problems.push("init.mcp_servers");
  const tools = Array.isArray(init.tools) ? init.tools.map(String) : [];
  const builtIn = tools.filter((t) => !t.startsWith("mcp__"));
  if (!same([...builtIn].sort(), [...o.builtInTools].sort())) problems.push("init.tools");
  const prefix = "mcp__storybloq__";
  if (tools.some((t) => t.startsWith("mcp__") && (!t.startsWith(prefix) || !mcpTools.includes(t.slice(prefix.length))))) problems.push("init.tools.mcp");
  return problems;
}
