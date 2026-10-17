import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, join, sep } from "node:path";
import { z } from "zod";
import {
  NodesMapSchema,
  validateOrchestratorOverlay,
  type NodesMap,
  type NodeHealth,
} from "../../src/models/federation-config.js";
import { hasOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { COUNTING_CONTRACT } from "../../src/federation/scanner.js";
import type { ProjectState } from "../../src/core/project-state.js";
import { readLedger } from "./ledger-reader.js";
import { BoardError } from "./errors.js";
import { clip } from "./text.js";
import { calendarDate } from "./history.js";
const count = z.number().int().min(0).max(10000000);
// T-486 U2-3b: an entry carries numbers a reader may show only on the
// current counting contract; a legacy or contract-1 entry may lack them.
const cacheEntry = z.object({
  ticketCount: count.optional(),
  openTickets: count.optional(),
  completeTickets: count.optional(),
  issueCount: count.optional(),
  openIssues: count.optional(),
  lastHandoverDate: z.string().nullable().optional(),
  lastHandoverTitle: z.string().nullable().optional(),
  reachable: z.boolean(),
  countingContract: count.optional(),
  legacy: z.boolean().optional(),
});
const cacheNode = z.object({
  ticketCount: count,
  openTickets: count,
  completeTickets: count,
  issueCount: count,
  openIssues: count,
  lastHandoverDate: z.string().nullable(),
  lastHandoverTitle: z.string().nullable(),
  reachable: z.boolean(),
});
const cacheSchema = z.object({
  lastScanTimestamp: z.string().max(80).datetime({ offset: true }),
  nodes: z.record(cacheEntry),
});
export type CachedNode = z.infer<typeof cacheNode>;
export interface FederationNode {
  name: string;
  kind: string;
  role: string;
  stack: string;
  summary: string;
  health: NodeHealth;
  cache: CachedNode | null;
  cacheState:
    | "missing"
    | "unavailable"
    | "fresh"
    | "stale"
    | "future"
    | "unreachable"
    | "legacy";
}
export interface Edge {
  type: "build" | "runtime";
  from: string;
  to: string;
  via?: string;
}
export interface Federation {
  isOrchestrator: boolean;
  nodes: FederationNode[];
  edges: Edge[];
  warnings: string[];
  scannedAt: string | null;
}
export interface Anchor {
  declared: string;
  canonical: string | null;
  identity: string | null;
}
export interface RootAccess {
  fixed: Anchor & { canonical: string };
  approved: Anchor[];
}
async function anchor(path: string): Promise<Anchor> {
  if (!isAbsolute(path))
    throw new BoardError("Approved node roots must be absolute directories.");
  const declared = resolve(path),
    stat = await lstat(declared, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new BoardError(
      "Approved roots must be real directories, not symbolic links.",
    );
  return {
    declared,
    canonical: await realpath(declared),
    identity: `${stat.dev}:${stat.ino}`,
  };
}
export async function captureRoots(
  root: string,
  approved: string[],
): Promise<RootAccess> {
  return {
    fixed: (await anchor(resolve(root))) as Anchor & { canonical: string },
    approved: await Promise.all(
      approved.map(async (path) => {
        try {
          return await anchor(path);
        } catch {
          return { declared: resolve(path), canonical: null, identity: null };
        }
      }),
    ),
  };
}
function configNodes(config: Record<string, unknown>) {
  if (config.type !== "orchestrator") return null;
  const result = NodesMapSchema.safeParse(config.nodes ?? {});
  if (!result.success)
    throw new BoardError(
      "The federation configuration needs local repair. Check node names, paths and relations.",
    );
  const nodes: NodesMap = Object.assign(Object.create(null), result.data),
    entries = Object.values(nodes);
  if (
    entries.length > 200 ||
    entries.reduce(
      (n, v) => n + v.dependsOn.length + (v.links?.length ?? 0),
      0,
    ) > 2000
  )
    throw new BoardError(
      "This federation exceeds the 200 node or 2,000 relation prototype limit.",
    );
  return nodes;
}
function projection(
  config: Record<string, unknown>,
  nodes: NodesMap | null,
  text: string | undefined,
): Federation {
  if (!nodes)
    return {
      isOrchestrator: false,
      nodes: [],
      edges: [],
      warnings: [],
      scannedAt: null,
    };
  let parsed: z.infer<typeof cacheSchema> | undefined;
  if (text !== undefined) {
    try {
      parsed = cacheSchema.parse(JSON.parse(text));
    } catch {
      /* Preserve invalid cache bytes. */
    }
  }
  const warnings: string[] = [];
  const overlay = validateOrchestratorOverlay({ ...config, nodes });
  // Canonical diagnostics may embed node paths. Project only relation diagnostics.
  for (const w of [...overlay.errors, ...overlay.warnings]) {
    if (w.startsWith("Dependency cycle")) warnings.push(clip(w, 500));
    else if (w.includes("dependsOn references")) warnings.push(clip(w, 500));
    else if (w.includes("links.to references"))
      warnings.push("Runtime relation: " + clip(w, 480));
    else if (w.startsWith("Duplicate path"))
      warnings.push("Some nodes share the same configured directory.");
  }
  const edges: Edge[] = [];
  for (const [name, n] of Object.entries(nodes)) {
    for (const dep of n.dependsOn)
      if (nodes[dep]) edges.push({ type: "build", from: dep, to: name });
    for (const link of n.links ?? [])
      if (nodes[link.to])
        edges.push({
          type: "runtime",
          from: name,
          to: link.to,
          ...(link.via ? { via: link.via } : {}),
        });
  }
  const age = parsed ? Date.now() - Date.parse(parsed.lastScanTimestamp) : 0;
  return {
    isOrchestrator: true,
    edges,
    warnings,
    scannedAt: parsed?.lastScanTimestamp ?? null,
    nodes: Object.entries(nodes).map(([name, n]) => {
      const raw =
        parsed && Object.hasOwn(parsed.nodes, name)
          ? parsed.nodes[name]
          : undefined;
      const counted =
        raw?.reachable &&
        raw.legacy !== true &&
        raw.countingContract === COUNTING_CONTRACT
          ? cacheNode.safeParse({
              ...raw,
              lastHandoverDate: raw.lastHandoverDate ?? null,
              lastHandoverTitle: raw.lastHandoverTitle ?? null,
            })
          : undefined;
      const cached = counted?.success
        ? {
            ...counted.data,
            lastHandoverDate: calendarDate(counted.data.lastHandoverDate),
            lastHandoverTitle:
              counted.data.lastHandoverTitle === null
                ? null
                : clip(counted.data.lastHandoverTitle, 240),
          }
        : null;
      return {
        name,
        kind: n.kind ?? "project",
        stack: n.stack,
        role: n.role,
        summary: n.summary,
        health: n.health,
        cache: cached,
        cacheState:
          text === undefined
            ? "missing"
            : !parsed
              ? "unavailable"
              : !raw
                ? "missing"
                : !raw.reachable
                  ? "unreachable"
                  : !cached
                    ? "legacy"
                    : age < 0
                    ? "future"
                    : age > 300000
                      ? "stale"
                      : "fresh",
      };
    }),
  };
}
export async function readFederation(root: string) {
  return readLedger(root, async (state, scope) => {
    const nodes = configNodes(state.config);
    return projection(
      state.config,
      nodes,
      nodes ? await scope.optionalText("federation-cache.json") : undefined,
    );
  });
}
const inside = (base: string, path: string) => {
  const suffix = relative(base, path);
  return suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep))
    ? suffix
    : null;
};
async function permittedRoot(
  path: string,
  access: RootAccess,
): Promise<string | null> {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path;
  const absolute = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(access.fixed.declared, expanded);
  const suffix =
    inside(access.fixed.declared, absolute) ??
    inside(access.fixed.canonical, absolute);
  if (suffix !== null) {
    let current = access.fixed.canonical;
    // The anchor itself is captured once; recheck it and each project-controlled child.
    for (const component of ["", ...suffix.split(sep).filter(Boolean)]) {
      if (component) current = join(current, component);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new BoardError("The node directory is unavailable.");
    }
    return current;
  }
  const approved = access.approved.find(
    (a) => absolute === a.declared || absolute === a.canonical,
  );
  if (!approved) return null;
  if (!approved.canonical)
    throw new BoardError("The approved node directory is unavailable.");
  const stat = await lstat(approved.canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new BoardError("The node directory is unavailable.");
  return approved.canonical;
}
export interface NodePreview {
  state: "ready" | "not-approved" | "unavailable";
  items: { id: string; displayId: string; title: string; status: string }[];
  total: number;
  offset: number;
  limit: number;
  message?: string;
}
export interface NodeDetail extends FederationNode {
  buildsAfter: string[];
  requiredBy: string[];
  runtimeIncoming: Edge[];
  runtimeOutgoing: Edge[];
  preview: NodePreview;
}
export async function readNode(
  root: string,
  access: RootAccess,
  name: string,
  offset: number,
  limit: number,
): Promise<NodeDetail> {
  const local = await readLedger(root, async (state, scope) => {
    const nodes = configNodes(state.config),
      node = nodes && Object.hasOwn(nodes, name) ? nodes[name] : undefined;
    if (!nodes || !node)
      throw new BoardError("This node is no longer available. Refresh Nodes.");
    const f = projection(
      state.config,
      nodes,
      await scope.optionalText("federation-cache.json"),
    );
    return {
      node,
      publicNode: f.nodes.find((n) => n.name === name)!,
      edges: f.edges,
      nodes,
    };
  });
  let preview: NodePreview = {
    state: "unavailable",
    items: [],
    total: 0,
    offset: 0,
    limit,
    message: "Node work is unavailable. Check its local ledger, then refresh.",
  };
  try {
    const target = await permittedRoot(local.node.path, access);
    if (target === null)
      preview = {
        ...preview,
        state: "not-approved",
        message:
          "Node preview needs startup approval for this external project.",
      };
    else
      preview = await readLedger(target, (state) => {
        const active = nodePreviewTickets(state);
        const start = Math.min(
          offset,
          Math.max(0, Math.ceil(active.length / limit) - 1) * limit,
        );
        return {
          state: "ready",
          items: active.slice(start, start + limit).map((t) => ({
            id: clip(t.id, 80),
            displayId: clip(t.displayId ?? t.id, 80),
            title: clip(t.title, 240),
            status: t.status,
          })),
          total: active.length,
          offset: start,
          limit,
        };
      });
  } catch {
    /* A node failure stays local and never echoes its configured root. */
  }
  return {
    ...local.publicNode,
    buildsAfter: local.node.dependsOn,
    requiredBy: Object.entries(local.nodes)
      .filter(([, n]) => n.dependsOn.includes(name))
      .map(([key]) => key),
    runtimeIncoming: local.edges.filter(
      (e) => e.type === "runtime" && e.to === name,
    ),
    runtimeOutgoing: local.edges.filter(
      (e) => e.type === "runtime" && e.from === name,
    ),
    preview,
  };
}

/** Active node work from the counted population (T-486 U2-3a), in progress first. */
export function nodePreviewTickets(state: ProjectState) {
  return state.countedLeafTickets
    .filter(
      (t) =>
        !hasOwnerCheckpoint(t) &&
        (t.status === "open" || t.status === "inprogress"),
    )
    .sort(
      (a, b) =>
        Number(b.status === "inprogress") -
          Number(a.status === "inprogress") ||
        (a.order ?? 0) - (b.order ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
