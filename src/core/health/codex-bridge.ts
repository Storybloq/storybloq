/**
 * T-502 check 3: Codex is installed, but is the review bridge registered.
 *
 * The check answers only what it can prove. Two ideas keep it honest:
 *
 * NAMES RESOLVE, ENTRIES CLASSIFY. Claude Code resolves an MCP server BY
 * NAME across three scopes (local > project > user), so for each name only
 * the highest-precedence definition exists as far as the running client is
 * concerned. A user-level bridge shadowed by a local entry of the same name
 * is NOT running, and counting it would produce a confident ok for a bridge
 * that cannot answer.
 *
 * A BRIDGE-RELATED NAME IS A CLAIM WE MUST NOT CONTRADICT. If a name looks
 * like the bridge but its launch form is not one we recognise, the answer is
 * `skip` "cannot verify" -- never `advise`. Telling a user to register a
 * bridge they have already registered in a form we simply do not parse is the
 * failure mode this rule exists to prevent. Classification is by launcher
 * grammar only: arguments never make a name bridge-related, so `echo
 * codex-claude-bridge@latest` under an unrelated name is not the bridge.
 */

import { basename, join } from "node:path";
import { shellArg } from "../shell-arg.js";
import { readJsonObject, skipCheck, adviseCheck, okCheck, type HealthCheck, type HealthContext, type HealthDeps, type McpLaunch, type McpProbe } from "./types.js";

const ID = "codex-bridge" as const;

/** `~/.claude.json` holds project state and is routinely hundreds of KiB. */
export const CLAUDE_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const CODEX_PROBE_CAP_MS = 2000;
/** T-509: per-bridge cap on the initialize handshake, bounded by the run budget. */
export const BRIDGE_PROBE_CAP_MS = 5000;
export const NATIVE_BINDING_RE = /Could not locate the bindings file|better-sqlite3|NODE_MODULE_VERSION|compiled against a different Node\.js version|ERR_DLOPEN_FAILED/i;

const BRIDGE_PACKAGE = "codex-claude-bridge";
const BRIDGE_NAMES = new Set(["codex-bridge", "codex-bridge-local"]);

type Scope = "local" | "project" | "user";

/** Lower number wins. Only a scope ABOVE a winner can shadow it. */
const PRECEDENCE: Readonly<Record<Scope, number>> = { local: 0, project: 1, user: 2 };
type Classification = "bridge" | "unverifiable" | "not-bridge";

/** A name is bridge-related from its NAME alone. Arguments never qualify it. */
export function isBridgeRelatedName(name: string): boolean {
  return BRIDGE_NAMES.has(name) || name.includes(BRIDGE_PACKAGE);
}

/**
 * The three launcher grammars, matched exactly. No flag skipping: an
 * unrecognised leading flag fails the grammar rather than being stepped over,
 * because `npx -p codex-claude-bridge@latest echo` installs the package and
 * runs something else entirely.
 */
export function isBridgeLaunch(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const command = (entry as Record<string, unknown>).command;
  const rawArgs = (entry as Record<string, unknown>).args;
  if (typeof command !== "string") return false;
  if (rawArgs !== undefined && !(Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string"))) return false;
  const args: string[] = Array.isArray(rawArgs) ? (rawArgs as string[]) : [];
  const base = basename(command);

  // (a) the bridge's own binary, any arguments.
  if (base === BRIDGE_PACKAGE) return true;

  // (b) node or bun running a path that contains the exact package segment.
  if (base === "node" || base === "bun") {
    const first = args[0];
    if (first === undefined || first.startsWith("-")) return false;
    return first.split(/[\\/]/).includes(BRIDGE_PACKAGE);
  }

  // (c) npx or bunx, an optional single -y/--yes, then the package, then any
  // trailing application arguments.
  if (base === "npx" || base === "bunx") {
    let i = 0;
    if (args[0] === "-y" || args[0] === "--yes") i = 1;
    const pkg = args[i];
    if (pkg === undefined) return false;
    return pkg === BRIDGE_PACKAGE || pkg.startsWith(`${BRIDGE_PACKAGE}@`);
  }

  return false;
}

function classify(name: string, entry: unknown): Classification {
  if (isBridgeLaunch(entry)) return "bridge";
  return isBridgeRelatedName(name) ? "unverifiable" : "not-bridge";
}

export async function checkCodexBridge(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  const base = { projectDir: ctx.projectDir };
  if (ctx.client === "codex") {
    return skipCheck(ID, "The codex-claude-bridge is a Claude Code MCP server, so this check does not apply when running under Codex.", "the bridge is a Claude Code MCP server", base);
  }

  const remaining = ctx.deadline - deps.now();
  const probe = deps.run("codex", ["--version"], Math.max(1, Math.min(CODEX_PROBE_CAP_MS, remaining)));
  if (probe.kind === "enoent") {
    return skipCheck(ID, "Codex is not installed, so there is no Codex review backend to register.", "Codex is not installed", base);
  }
  if (probe.kind !== "ok") {
    return skipCheck(
      ID,
      "`codex --version` did not answer, so Storybloq cannot tell whether Codex is installed.",
      "codex --version did not answer",
      { ...base, probe: probe.kind },
    );
  }

  const claudeJsonPath = deps.claudeJsonPath;
  const mcpJsonPath = join(ctx.projectDir, ".mcp.json");
  const claudeJson = readJsonObject(deps, claudeJsonPath, CLAUDE_JSON_MAX_BYTES);
  const mcpJson = readJsonObject(deps, mcpJsonPath, CLAUDE_JSON_MAX_BYTES);

  // Each scope resolves to a server map or to "unknown". A nested field that
  // is PRESENT but the wrong shape is unknown, not empty: a malformed
  // `projects` block or a malformed `disabledMcpjsonServers` array leaves
  // real registration evidence unresolved, and treating it as an empty map
  // would let a lower scope look like the winner (or produce a
  // register-the-bridge advisory) on evidence we never actually read.
  const local = resolveLocalScope(claudeJson, claudeJsonPath, ctx.projectDir);
  const user = resolveUserScope(claudeJson, claudeJsonPath);
  const project = resolveProjectScope(mcpJson, mcpJsonPath, local.disabled, claudeJsonPath);

  // Winning definition per name, highest precedence first.
  const scopes: ReadonlyArray<{ scope: Scope; read: ScopeRead }> = [
    { scope: "local", read: local.read },
    { scope: "project", read: project },
    { scope: "user", read: user },
  ];
  const winners = new Map<string, { scope: Scope; entry: unknown }>();
  for (const { scope, read } of scopes) {
    if (read.kind !== "ok") continue;
    for (const [name, entry] of Object.entries(read.servers)) {
      if (!winners.has(name)) winners.set(name, { scope, entry });
    }
  }

  // An unreadable source is only harmless BELOW a proven winner. `~/.claude.json`
  // carries the local scope, which outranks everything, so when it cannot be
  // read no winner at all is trustworthy; an unreadable `.mcp.json` still
  // leaves a LOCAL winner standing, because nothing shadows the local scope.
  const unreadable: ReadonlyArray<{ path: string; highest: number }> = scopes
    .filter((s): s is { scope: Scope; read: Extract<ScopeRead, { kind: "indeterminate" }> } => s.read.kind === "indeterminate")
    .map((s) => ({ path: s.read.path, highest: PRECEDENCE[s.scope] }));

  // T-509: registration is not health. Every trustworthy bridge winner is
  // collected (precedence order) and LAUNCHED below; a bridge that is
  // registered but cannot answer initialize is exactly what this check is for.
  const bridges: Array<{ name: string; scope: Scope; entry: Record<string, unknown> }> = [];
  for (const [name, { scope, entry }] of winners) {
    if (classify(name, entry) !== "bridge") continue;
    if (unreadable.some((u) => u.highest < PRECEDENCE[scope])) continue; // could be shadowed
    bridges.push({ name, scope, entry: entry as Record<string, unknown> });
  }

  // No trustworthy bridge. An unreadable source now decides the answer: it
  // could shadow what we did find, or supply the bridge we did not.
  if (bridges.length === 0 && unreadable.length > 0) {
    const { path } = unreadable[0]!;
    return skipCheck(
      ID,
      `Storybloq could not read ${path}, so it cannot tell whether the codex-claude-bridge review backend is registered.`,
      `unreadable: ${path}`,
      base,
    );
  }

  if (bridges.length === 0) {
    for (const [name, { scope, entry }] of winners) {
      if (classify(name, entry) === "unverifiable") {
        return skipCheck(
          ID,
          `The MCP server \`${name}\` looks like the codex-claude-bridge but Storybloq does not recognise how it is launched, so it cannot confirm the review backend is working.`,
          `cannot verify ${name}`,
          { ...base, scope, name },
        );
      }
    }
    return noBridgeRegistered(deps, winners, base);
  }

  // Probe sequentially so each bridge gets what the budget still allows; the
  // adapter itself refuses to launch under the floor and says so.
  const results: Array<{ name: string; scope: Scope; launch: McpLaunch; probe: McpProbe }> = [];
  for (const b of bridges) {
    const launch = normaliseLaunch(b.entry);
    const capMs = Math.max(1, Math.min(BRIDGE_PROBE_CAP_MS, ctx.deadline - deps.now()));
    const probe = await deps.probeMcp(launch, ctx.deadline, capMs);
    results.push({ name: b.name, scope: b.scope, launch, probe });
  }
  const first = results[0]!;
  const detail = {
    ...base,
    scope: first.scope,
    name: first.name,
    bridges: JSON.stringify(results.map((r) => ({
      name: r.name,
      scope: r.scope,
      probe: r.probe.kind,
      ...(r.probe.kind === "ok" ? { serverName: r.probe.serverName } : {}),
      ...(degradedNativeModule(r.probe) ? { degraded: "native-module" } : {}),
      ...("allocatedMs" in r.probe ? { allocatedMs: r.probe.allocatedMs } : {}),
    }))),
  };

  if (results.every((r) => r.probe.kind === "ok" && !degradedNativeModule(r.probe))) {
    const names = results.map((r) => `\`${r.name}\` (${r.scope} scope)`).join(" and ");
    return okCheck(ID, `Codex is installed and the codex-claude-bridge review backend answers as ${names}.`, detail);
  }

  const clauses = results
    .filter((r) => r.probe.kind !== "ok" || degradedNativeModule(r.probe))
    .map((r) => `\`${r.name}\` (${r.scope} scope) ${describeFailure(r, deps, winners)}`);
  return adviseCheck(ID, `Codex is installed but the codex-claude-bridge review backend is registered but not healthy: ${clauses.join(" ")}`, detail);
}

/** The registration as an argv, verbatim, with its env map as overrides. */
function normaliseLaunch(entry: Record<string, unknown>): McpLaunch {
  const command = entry["command"] as string;
  const args = Array.isArray(entry["args"]) ? (entry["args"] as string[]) : [];
  const envOverrides: Record<string, string> = {};
  const env = entry["env"];
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") envOverrides[k] = v;
    }
  }
  return { argv: [command, ...args], envOverrides };
}

/** The `codex-bridge` name's effective winner when it is NOT the bridge, for repair text. */
function foreignCodexBridge(winners: Map<string, { scope: Scope; entry: unknown }>): { scope: Scope; argv: string } | null {
  const w = winners.get("codex-bridge");
  if (!w || isBridgeLaunch(w.entry)) return null;
  const e = (w.entry ?? {}) as Record<string, unknown>;
  const args = Array.isArray(e["args"]) ? (e["args"] as unknown[]).map(String) : [];
  const command = typeof e["command"] === "string" ? e["command"] : JSON.stringify(e["command"] ?? null);
  const argv = [command, ...args].map((a) => shellArg(a)).join(" ");
  return { scope: w.scope, argv };
}

/** How to get the bundled bridge registered, naming whatever would shadow it first. */
function setupRepair(winners: Map<string, { scope: Scope; entry: unknown }>): string {
  const foreign = foreignCodexBridge(winners);
  if (foreign !== null) {
    return `\`codex-bridge\` is registered at ${foreign.scope} scope as ${foreign.argv}, which is not the bridge; remove it (claude mcp remove codex-bridge -s ${foreign.scope}) and run storybloq setup-skill.`;
  }
  return "Run storybloq setup-skill.";
}

function noBridgeRegistered(
  deps: HealthDeps,
  winners: Map<string, { scope: Scope; entry: unknown }>,
  base: Record<string, string>,
): HealthCheck {
  const bundled = deps.bundledBridge();
  if (bundled.kind === "installed") {
    // A non-bridge entry NAMED codex-bridge never reaches here: the name is
    // bridge-related, so the T-502 "cannot verify" skip above already
    // answered. setupRepair's removal clause therefore only ever names a
    // shadowing entry from the probe path.
    return adviseCheck(ID, `Codex is installed but the bundled codex-claude-bridge review backend is not registered for Claude Code. ${setupRepair(winners)}`, { ...base, bundled: bundled.version });
  }
  if (bundled.kind === "unusable") {
    return adviseCheck(
      ID,
      `Codex is installed but the bundled codex-claude-bridge is unusable (${bundled.reason}); reinstall with npm install -g @storybloq/storybloq@latest.`,
      { ...base, bundled: "unusable" },
    );
  }
  return skipCheck(
    ID,
    "No codex-claude-bridge is registered and the bundled copy did not install, so there is no Codex review backend to check.",
    "no bridge resolves",
    base,
  );
}

/**
 * The bridge (1.8.0) answers initialize even when better-sqlite3 cannot load:
 * it logs "review storage unavailable" to stderr and runs without history.
 * That is not a healthy review backend, so an ok answer with that stderr is
 * judged like a native-module failure.
 */
function degradedNativeModule(p: McpProbe): boolean {
  return p.kind === "ok" && NATIVE_BINDING_RE.test(p.stderr);
}

/** The first line that reads as an error, else the first non-empty line. A Node
 *  MODULE_NOT_FOUND stack opens with a loader frame, which tells the user nothing. */
function firstErrorLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.find((l) => /^(\w*Error\b|error:)/i.test(l)) ?? lines[0] ?? "";
}

/** The replace steps for one failing registration: drop it, let setup register the bundled bridge. */
function reregister(r: { name: string; scope: Scope }): string {
  return `claude mcp remove ${shellArg(r.name)} -s ${r.scope}, then storybloq setup-skill registers the bundled bridge`;
}

/** The executable whose owning package a rebuild would run in, per launcher grammar; null for npx/bunx. */
function executableOf(launch: McpLaunch): string | null {
  const [command, ...args] = launch.argv;
  if (command === undefined) return null;
  const b = basename(command);
  if (b === BRIDGE_PACKAGE) return command;
  if (b === "node" || b === "bun") return args[0] ?? null;
  return null;
}

function describeFailure(
  r: { name: string; scope: Scope; launch: McpLaunch; probe: McpProbe },
  deps: HealthDeps,
  winners: Map<string, { scope: Scope; entry: unknown }>,
): string {
  const p = r.probe;
  const argv = r.launch.argv.map((a) => shellArg(a)).join(" ");
  switch (p.kind) {
    case "ok": {
      if (!degradedNativeModule(p)) return "answers.";
      const exe = executableOf(r.launch);
      const dir = exe === null ? null : deps.nativeRebuildDir(exe);
      const fix = dir !== null
        ? `Run: (cd ${shellArg(dir)} && npm rebuild better-sqlite3)`
        : `rebuild better-sqlite3 inside the copy that registration runs (${r.scope} ${r.name}: ${argv})`;
      return `answers but cannot load its native module, so reviews run without history. ${fix}`;
    }
    case "not-attempted":
      return `was not probed (${p.reason}); re-run storybloq health --only codex-bridge to give it the full budget.`;
    case "timeout":
      return `did not answer the initialize request within ${p.allocatedMs} ms; launch it by hand (${argv}) and check it prints a JSON-RPC answer to an initialize line, or replace it: ${reregister(r)}.`;
    case "enoent":
      return `cannot be launched: ${shellArg(r.launch.argv[0] ?? "")} was not found (registered as ${argv}); install it or fix the registered command (${reregister(r)}).`;
    case "failed": {
      if (NATIVE_BINDING_RE.test(p.stderr)) {
        const exe = executableOf(r.launch);
        const dir = exe === null ? null : deps.nativeRebuildDir(exe);
        if (dir !== null) {
          return `failed to load its native module. Run: (cd ${shellArg(dir)} && npm rebuild better-sqlite3)`;
        }
        const shadow = foreignCodexBridge(winners);
        // Replacing means removing BOTH the entry that would shadow the bundled
        // registration and the failing registration itself; otherwise the next
        // health run probes and advises on the same broken bridge again.
        const replace = shadow !== null && shadow.scope !== "user"
          ? `remove the ${shadow.scope}-scope \`codex-bridge\` entry first (claude mcp remove codex-bridge -s ${shadow.scope}), then the failing registration (claude mcp remove ${shellArg(r.name)} -s ${r.scope}), then run storybloq setup-skill`
          : reregister(r);
        return `failed to load its native module, and the bridge's package directory could not be established from this registration (${r.scope} ${r.name}: ${argv}); rebuild inside the copy that registration runs, or replace it: ${replace}.`;
      }
      const line = firstErrorLine(p.stderr);
      const exit = p.code !== null ? `exit code ${p.code}` : p.signal !== null ? `signal ${p.signal}` : p.reason;
      return `${p.reason} (${exit}${line ? `: ${line}` : ""}); launch it by hand to see the error.`;
    }
  }
}

/** A scope's server map, or an admission that we could not establish it. */
type ScopeRead =
  | { readonly kind: "ok"; readonly servers: Record<string, unknown> }
  | { readonly kind: "indeterminate"; readonly path: string };

type JsonRead = ReturnType<typeof readJsonObject>;

/** A nested field: missing, present and an object, or present and malformed. */
type Field<T> = { readonly kind: "absent" } | { readonly kind: "ok"; readonly value: T } | { readonly kind: "malformed" };

function objectField(container: Record<string, unknown>, key: string): Field<Record<string, unknown>> {
  const value = container[key];
  if (value === undefined || value === null) return { kind: "absent" };
  return typeof value === "object" && !Array.isArray(value)
    ? { kind: "ok", value: value as Record<string, unknown> }
    : { kind: "malformed" };
}

function stringArrayField(container: Record<string, unknown>, key: string): Field<readonly string[]> {
  const value = container[key];
  if (value === undefined || value === null) return { kind: "absent" };
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { kind: "malformed" };
  return { kind: "ok", value: value as readonly string[] };
}

/**
 * LOCAL scope plus the project's `.mcp.json` disablement list, which lives in
 * the same file. Both are returned together because one parse yields both and
 * the disablement list decides what the PROJECT scope contains.
 */
function resolveLocalScope(
  claudeJson: JsonRead,
  path: string,
  projectDir: string,
): { read: ScopeRead; disabled: Field<readonly string[]> } {
  // An ABSENT file is a determinate empty answer; only an unreadable one is unknown.
  if (claudeJson.kind === "indeterminate") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (claudeJson.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const projects = objectField(claudeJson.value, "projects");
  if (projects.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (projects.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const entry = objectField(projects.value, projectDir);
  if (entry.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (entry.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const servers = objectField(entry.value, "mcpServers");
  const disabled = stringArrayField(entry.value, "disabledMcpjsonServers");
  if (servers.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled };
  return { read: { kind: "ok", servers: servers.kind === "ok" ? servers.value : {} }, disabled };
}

function resolveUserScope(claudeJson: JsonRead, path: string): ScopeRead {
  if (claudeJson.kind === "indeterminate") return { kind: "indeterminate", path };
  if (claudeJson.kind === "absent") return { kind: "ok", servers: {} };
  const servers = objectField(claudeJson.value, "mcpServers");
  if (servers.kind === "malformed") return { kind: "indeterminate", path };
  return { kind: "ok", servers: servers.kind === "ok" ? servers.value : {} };
}

/**
 * PROJECT scope: `.mcp.json`'s servers minus the names the local scope
 * disabled. A malformed disablement list makes this scope unknown even when
 * `.mcp.json` itself read cleanly, and names the file the list lives in --
 * that is where the user has to look.
 */
function resolveProjectScope(
  mcpJson: JsonRead,
  path: string,
  disabled: Field<readonly string[]>,
  disabledPath: string,
): ScopeRead {
  if (mcpJson.kind === "indeterminate") return { kind: "indeterminate", path };
  if (mcpJson.kind === "absent") return { kind: "ok", servers: {} };
  const servers = objectField(mcpJson.value, "mcpServers");
  if (servers.kind === "malformed") return { kind: "indeterminate", path };
  const raw = servers.kind === "ok" ? servers.value : {};
  if (Object.keys(raw).length === 0) return { kind: "ok", servers: {} };
  if (disabled.kind === "malformed") return { kind: "indeterminate", path: disabledPath };
  const names = new Set(disabled.kind === "ok" ? disabled.value : []);
  const kept: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!names.has(name)) kept[name] = entry;
  }
  return { kind: "ok", servers: kept };
}
