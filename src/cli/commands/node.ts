import { displayIdOf } from "../../core/resolver.js";
import { accessSync, realpathSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { withProjectLock, writeConfigUnlocked } from "../../core/project-loader.js";
import {
  NodeNameSchema,
  NodeSchema,
  NodeLinkSchema,
  PathSafetySchema,
  validateOrchestratorOverlay,
  RESERVED_NODE_NAMES,
} from "../../models/federation-config.js";
import type { Config } from "../../models/config.js";
import type { OutputFormat } from "../../models/types.js";
import { assertUpdateHasFields } from "../helpers.js";
import {
  formatError,
  successEnvelope,
  ExitCode,
} from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function resolveAndValidatePath(
  rawPath: string,
  orchestratorRoot: string,
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  const safetyResult = PathSafetySchema.safeParse(rawPath);
  if (!safetyResult.success) {
    return { ok: false, reason: safetyResult.error.issues[0]?.message ?? "Invalid path" };
  }

  const expanded = expandTilde(rawPath);
  const abs = resolve(orchestratorRoot, expanded);

  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: `Path does not exist: ${abs}` };
  }

  try {
    accessSync(real, constants.R_OK);
  } catch {
    return { ok: false, reason: `Path is not readable: ${real}` };
  }

  let orchReal: string;
  try {
    orchReal = realpathSync(orchestratorRoot);
  } catch {
    return { ok: false, reason: `Cannot resolve orchestrator path: ${orchestratorRoot}` };
  }
  if (real === orchReal) {
    return { ok: false, reason: "Path is the orchestrator itself (self-reference)" };
  }

  return { ok: true, absolutePath: real };
}

export interface NodeAddOptions {
  name: string;
  path: string;
  stack?: string;
  role?: string;
  kind?: string;
  summary?: string;
  dependsOn?: string[];
  links?: Array<{ to: string; via?: string }>;
}

export async function handleNodeAdd(
  opts: NodeAddOptions,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const nameResult = NodeNameSchema.safeParse(opts.name);
  if (!nameResult.success) {
    return {
      output: formatError(
        "invalid_input",
        `Invalid node name "${opts.name}": ${nameResult.error.issues.map((i) => i.message).join(", ")}`,
        format,
      ),
      exitCode: ExitCode.USER_ERROR,
    };
  }

  if (RESERVED_NODE_NAMES.includes(opts.name)) {
    return {
      output: formatError("invalid_input", `Node name "${opts.name}" is reserved.`, format),
      exitCode: ExitCode.USER_ERROR,
    };
  }

  const pathResult = resolveAndValidatePath(opts.path, root);
  if (!pathResult.ok) {
    return {
      output: formatError("invalid_input", pathResult.reason, format),
      exitCode: ExitCode.USER_ERROR,
    };
  }

  for (const link of opts.links ?? []) {
    const linkResult = NodeLinkSchema.safeParse(link);
    if (!linkResult.success) {
      return {
        output: formatError(
          "invalid_input",
          `Invalid link: ${linkResult.error.issues.map((i) => i.message).join(", ")}`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
    }
  }

  const storedPath = pathResult.absolutePath;
  const nodeEntry: Record<string, unknown> = { path: storedPath };
  if (opts.stack) nodeEntry.stack = opts.stack;
  if (opts.role) nodeEntry.role = opts.role;
  if (opts.kind) nodeEntry.kind = opts.kind;
  if (opts.summary) nodeEntry.summary = opts.summary;
  if (opts.dependsOn && opts.dependsOn.length > 0) nodeEntry.dependsOn = opts.dependsOn;
  if (opts.links && opts.links.length > 0) nodeEntry.links = opts.links;

  const nodeParseResult = NodeSchema.safeParse(nodeEntry);
  if (!nodeParseResult.success) {
    return {
      output: formatError(
        "invalid_input",
        `Invalid node config: ${nodeParseResult.error.issues.map((i) => i.message).join(", ")}`,
        format,
      ),
      exitCode: ExitCode.USER_ERROR,
    };
  }

  let result!: CommandResult;
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = state.config as Record<string, unknown>;

    if (config.type !== "orchestrator") {
      result = {
        output: formatError(
          "invalid_input",
          "Node commands are only available on orchestrator projects. Use `storybloq init --type orchestrator` first.",
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const nodes = (config.nodes as Record<string, unknown>) ?? {};
    if (Object.hasOwn(nodes, opts.name)) {
      result = {
        output: formatError(
          "conflict",
          `Node "${opts.name}" already exists. Remove it first or choose a different name.`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const nodeKeys = new Set(Object.keys(nodes));
    for (const dep of opts.dependsOn ?? []) {
      if (!nodeKeys.has(dep)) {
        result = {
          output: formatError(
            "invalid_input",
            `dependsOn references non-existent node "${dep}". Add it first or add both in order.`,
            format,
          ),
          exitCode: ExitCode.USER_ERROR,
        };
        return;
      }
    }

    const updatedNodes = { ...nodes, [opts.name]: nodeEntry };
    const updatedConfig = { ...config, nodes: updatedNodes };

    const overlay = validateOrchestratorOverlay(updatedConfig);
    if (!overlay.valid) {
      result = {
        output: formatError(
          "invalid_input",
          `Validation failed: ${overlay.errors.join("; ")}`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    await writeConfigUnlocked(updatedConfig as Config, root);

    const warnings = overlay.warnings.length > 0
      ? `\nWarnings: ${overlay.warnings.join("; ")}`
      : "";

    if (format === "json") {
      result = {
        output: JSON.stringify(successEnvelope({ name: opts.name, path: storedPath, warnings: overlay.warnings }), null, 2),
      };
    } else {
      result = {
        output: `Added node "${opts.name}" (${storedPath})${warnings}`,
      };
    }
  });

  return result;
}

export interface NodeRemoveOptions {
  force?: boolean;
  prune?: boolean;
}

export async function handleNodeRemove(
  name: string,
  opts: NodeRemoveOptions,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let result!: CommandResult;
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = state.config as Record<string, unknown>;

    if (config.type !== "orchestrator") {
      result = {
        output: formatError("invalid_input", "Node commands are only available on orchestrator projects.", format),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const nodes = (config.nodes as Record<string, unknown>) ?? {};
    if (!Object.hasOwn(nodes, name)) {
      result = {
        output: formatError("not_found", `Node "${name}" not found in orchestrator config.`, format),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const dependents: string[] = [];
    for (const [key, value] of Object.entries(nodes)) {
      if (key === name) continue;
      const node = value as Record<string, unknown>;
      const deps = Array.isArray(node.dependsOn) ? (node.dependsOn as string[]) : [];
      if (deps.includes(name)) {
        dependents.push(key);
      }
    }

    const crossNodeRefs: string[] = [];
    const prefix = `${name}:`;
    for (const ticket of state.tickets) {
      const refs = Array.isArray(ticket.crossNodeBlockedBy) ? ticket.crossNodeBlockedBy as string[] : [];
      for (const ref of refs) {
        if (ref.startsWith(prefix)) {
          crossNodeRefs.push(`${displayIdOf(ticket)} -> ${ref}`);
        }
      }
    }

    const hasDependents = dependents.length > 0;
    const hasCrossNodeRefs = crossNodeRefs.length > 0;

    if ((hasDependents && !opts.force && !opts.prune) || (hasCrossNodeRefs && !opts.force)) {
      const issues: string[] = [];
      if (hasDependents) {
        issues.push(`Nodes depending on "${name}": ${dependents.join(", ")}`);
      }
      if (hasCrossNodeRefs) {
        issues.push(`Tickets with crossNodeBlockedBy refs: ${crossNodeRefs.join(", ")}`);
      }
      const hint = hasCrossNodeRefs
        ? "Use --force to remove anyway (dangling refs will remain)."
        : "Use --force to remove anyway, or --prune to remove and clean dependsOn references.";
      result = {
        output: formatError(
          "conflict",
          `Cannot remove node "${name}": ${issues.join(". ")}. ${hint}`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const updatedNodes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nodes)) {
      if (key === name) continue;
      const node = value as Record<string, unknown>;
      if (opts.prune) {
        const deps = Array.isArray(node.dependsOn) ? (node.dependsOn as string[]) : [];
        if (deps.includes(name)) {
          updatedNodes[key] = { ...node, dependsOn: deps.filter((d) => d !== name) };
          continue;
        }
      }
      updatedNodes[key] = node;
    }

    const updatedConfig = { ...config, nodes: updatedNodes };
    await writeConfigUnlocked(updatedConfig as Config, root);

    const warnings: string[] = [];
    if (opts.prune && hasDependents) {
      warnings.push(`Cleaned dependsOn refs in: ${dependents.join(", ")}`);
    }
    if (hasCrossNodeRefs && opts.force) {
      warnings.push(`Dangling crossNodeBlockedBy refs remain in tickets: ${crossNodeRefs.map((r) => r.split(" -> ")[0]).join(", ")}`);
    }

    const warningText = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";

    if (format === "json") {
      result = {
        output: JSON.stringify(successEnvelope({ name, removed: true, warnings }), null, 2),
      };
    } else {
      result = {
        output: `Removed node "${name}"${warningText}`,
      };
    }
  });

  return result;
}

export interface NodeUpdateOptions {
  path?: string;
  stack?: string;
  role?: string;
  kind?: string;
  summary?: string;
  dependsOn?: string[];
  clearDependsOn?: boolean;
  links?: Array<{ to: string; via?: string }>;
  clearLinks?: boolean;
}

export async function handleNodeUpdate(
  name: string,
  opts: NodeUpdateOptions,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  // Without this, a bare `node update <name>` printed `Updated node "x" ()` --
  // an empty change list -- at exit 0 with the config untouched (ISS-892).
  assertUpdateHasFields(
    opts as unknown as Record<string, unknown>,
    "node",
    "path, stack, role, kind, summary, dependsOn, clearDependsOn, links, clearLinks",
  );
  if (opts.path) {
    const pathResult = resolveAndValidatePath(opts.path, root);
    if (!pathResult.ok) {
      return {
        output: formatError("invalid_input", pathResult.reason, format),
        exitCode: ExitCode.USER_ERROR,
      };
    }
    opts.path = pathResult.absolutePath;
  }

  for (const link of opts.links ?? []) {
    const linkResult = NodeLinkSchema.safeParse(link);
    if (!linkResult.success) {
      return {
        output: formatError(
          "invalid_input",
          `Invalid link: ${linkResult.error.issues.map((i) => i.message).join(", ")}`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
    }
  }

  let result!: CommandResult;
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = state.config as Record<string, unknown>;

    if (config.type !== "orchestrator") {
      result = {
        output: formatError("invalid_input", "Node commands are only available on orchestrator projects.", format),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const nodes = (config.nodes as Record<string, unknown>) ?? {};
    if (!Object.hasOwn(nodes, name)) {
      result = {
        output: formatError("not_found", `Node "${name}" not found in orchestrator config.`, format),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const existing = { ...(nodes[name] as Record<string, unknown>) };

    if (opts.path !== undefined) existing.path = opts.path;
    if (opts.stack !== undefined) existing.stack = opts.stack;
    if (opts.role !== undefined) existing.role = opts.role;
    if (opts.kind !== undefined) existing.kind = opts.kind;
    if (opts.summary !== undefined) existing.summary = opts.summary;

    if (opts.clearDependsOn) {
      existing.dependsOn = [];
    } else if (opts.dependsOn !== undefined) {
      const nodeKeys = new Set(Object.keys(nodes));
      for (const dep of opts.dependsOn) {
        if (!nodeKeys.has(dep)) {
          result = {
            output: formatError("invalid_input", `dependsOn references non-existent node "${dep}".`, format),
            exitCode: ExitCode.USER_ERROR,
          };
          return;
        }
      }
      existing.dependsOn = opts.dependsOn;
    }

    if (opts.clearLinks) {
      delete existing.links;
    } else if (opts.links !== undefined) {
      existing.links = opts.links;
    }

    const nodeParseResult = NodeSchema.safeParse(existing);
    if (!nodeParseResult.success) {
      result = {
        output: formatError(
          "invalid_input",
          `Invalid node config: ${nodeParseResult.error.issues.map((i) => i.message).join(", ")}`,
          format,
        ),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    const updatedNodes = { ...nodes, [name]: existing };
    const updatedConfig = { ...config, nodes: updatedNodes };

    const overlay = validateOrchestratorOverlay(updatedConfig);
    if (!overlay.valid) {
      result = {
        output: formatError("invalid_input", `Validation failed: ${overlay.errors.join("; ")}`, format),
        exitCode: ExitCode.USER_ERROR,
      };
      return;
    }

    await writeConfigUnlocked(updatedConfig as Config, root);

    const changes: string[] = [];
    if (opts.path !== undefined) changes.push("path");
    if (opts.stack !== undefined) changes.push("stack");
    if (opts.role !== undefined) changes.push("role");
    if (opts.kind !== undefined) changes.push("kind");
    if (opts.summary !== undefined) changes.push("summary");
    if (opts.clearDependsOn) changes.push("dependsOn (cleared)");
    else if (opts.dependsOn !== undefined) changes.push("dependsOn");
    if (opts.clearLinks) changes.push("links (cleared)");
    else if (opts.links !== undefined) changes.push("links");

    const warnings = overlay.warnings.length > 0
      ? `\nWarnings: ${overlay.warnings.join("; ")}`
      : "";

    if (format === "json") {
      result = {
        output: JSON.stringify(successEnvelope({ name, updated: changes, warnings: overlay.warnings }), null, 2),
      };
    } else {
      result = {
        output: `Updated node "${name}" (${changes.join(", ")})${warnings}`,
      };
    }
  });

  return result;
}

export function handleNodeList(ctx: CommandContext): CommandResult {
  const config = ctx.state.config as Record<string, unknown>;

  if (config.type !== "orchestrator") {
    // ISS-811: the LIST read path is benign on non-orchestrator projects.
    // Single-repo mode returns an empty node list plus a note, so cold
    // orchestrate Step 1 opens without an error. Write/mutating node paths
    // (add/remove/update, node_init) still error as before.
    const note = "not an orchestrator project; single-repo mode";
    if (ctx.format === "json") {
      return { output: JSON.stringify(successEnvelope({ nodes: [], note }), null, 2) };
    }
    return { output: "No federation nodes: not an orchestrator project (single-repo mode)." };
  }

  const nodes = (config.nodes as Record<string, Record<string, unknown>>) ?? {};
  const entries = Object.entries(nodes);

  if (entries.length === 0) {
    if (ctx.format === "json") {
      return { output: JSON.stringify(successEnvelope({ nodes: [] }), null, 2) };
    }
    return { output: "No nodes configured. Use `storybloq node add` to add nodes." };
  }

  if (ctx.format === "json") {
    const nodeList = entries.map(([name, node]) => ({
      name,
      path: node.path ?? "",
      stack: node.stack ?? "",
      role: node.role ?? "",
      health: node.health ?? "grey",
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
    }));
    return { output: JSON.stringify(successEnvelope({ nodes: nodeList }), null, 2) };
  }

  const lines: string[] = ["# Nodes", ""];
  const header = "| Name | Path | Stack | Role | Health | Depends On |";
  const sep = "|------|------|-------|------|--------|------------|";
  lines.push(header, sep);

  for (const [name, node] of entries) {
    const path = (node.path as string) ?? "";
    const stack = (node.stack as string) ?? "";
    const role = (node.role as string) ?? "";
    const health = (node.health as string) ?? "grey";
    const deps = Array.isArray(node.dependsOn) ? (node.dependsOn as string[]).join(", ") : "";
    lines.push(`| ${name} | ${path} | ${stack} | ${role} | ${health} | ${deps} |`);
  }

  return { output: lines.join("\n") };
}
