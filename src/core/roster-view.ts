/**
 * T-507 commit B: the roster as `storybloq status`, `storybloq roster list`
 * and `storybloq_roster_get` present it.
 *
 * `core/roster.ts` is pure over records and endpoint projections. This layer
 * owns what sits around it: the Bus read (endpoints and their liveness) when
 * the project has the Bus feature on, the status projection (running seats
 * only; terminal seats are counted but hidden, the ledger does not forget
 * them and `roster list --all` still shows them), and the federated
 * aggregation (the orchestrator's own roster plus every reachable node's,
 * each seat labelled with its node).
 *
 * Nothing here throws for a degraded source: a Bus that cannot be read, a
 * node whose config is unparseable, a node that did not resolve, each becomes
 * a diagnostic line on the view, so status never fails on the roster's
 * account (the same rule every other status side-read follows).
 */

import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { isBusEnabled } from "../bus/config.js";
import { endpointLiveness } from "../bus/endpoints.js";
import { readJsonNoFollow } from "../bus/io.js";
import { BusError } from "../bus/errors.js";
import { resolveBusPaths } from "../bus/paths.js";
import { BusEndpointSchema, type BusEndpoint } from "../bus/schemas.js";
import { readBoundedNoFollow } from "../presence/io.js";
import type { Config } from "../models/config.js";
import type { ResolvedNode } from "../federation/resolver.js";
import {
  ROSTER_RESULT_CAP,
  ROSTER_SCAN_CAP,
  mergeBusSeats,
  readRoster,
  summarizeRoster,
  type BusSeatSource,
  type RosterSeatView,
  type RosterView,
  type RosterReadUncertainty,
} from "./roster.js";

/** A roster view plus whether the Bus endpoint input itself was cut. */
export interface BusRosterView extends RosterView {
  readonly busScanTruncated: boolean;
}

/** A seat as status shows it: the view plus the node it was read from (null for the project itself). */
export interface StatusRosterSeat extends RosterSeatView {
  readonly node: string | null;
}

/** The `roster` block of a status payload. `seats` holds running seats only; the counts cover every seat read. */
export interface StatusRoster {
  readonly seats: readonly StatusRosterSeat[];
  readonly live: number;
  readonly stale: number;
  readonly terminal: number;
  readonly scanTruncated: boolean;
  readonly resultTruncated: boolean;
  /** The Bus endpoint input itself was cut at the scan cap (false when the Bus is off or not read). */
  readonly busScanTruncated: boolean;
  readonly diagnostics: readonly string[];
}

export type LivenessProbe = (endpoint: BusEndpoint) => Promise<"attached" | "offline" | "unknown">;

/** Upper bound on a node's config.json read for the federated roster; the file only needs `features.bus`. */
const NODE_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * The endpoint directory, bounded BEFORE any file is opened: names are sorted,
 * at most `ROSTER_SCAN_CAP` are read (no-follow, byte-capped, schema-checked),
 * and whether more existed is reported. `listEndpoints` reads everything; the
 * roster is a status side-read and must not.
 *
 * ISS-1290: every `*.json` name is a candidate, cut at the cap BEFORE any type
 * check, and each is lstat'd, never followed. A symlink or other non-regular
 * entry is returned in `unsafe` rather than silently dropped, so a caller can
 * tell "no endpoint" from "an endpoint it refused to read". `unsafe` is kept
 * out of `findings`, so the printed diagnostics are unchanged.
 */
async function listEndpointsBounded(endpointsDir: string): Promise<{ endpoints: BusEndpoint[]; findings: string[]; unsafe: string[]; truncated: boolean }> {
  let entries;
  try {
    entries = await readdir(endpointsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { endpoints: [], findings: [], unsafe: [], truncated: false };
    throw new BusError("io_error", `Cannot enumerate ${basename(endpointsDir)}`, err);
  }
  const candidates = entries.map((entry) => entry.name).filter((name) => name.endsWith(".json")).sort();
  const endpoints: BusEndpoint[] = [];
  const findings: string[] = [];
  const unsafe: string[] = [];
  for (const filename of candidates.slice(0, ROSTER_SCAN_CAP)) {
    try {
      const st = await lstat(join(endpointsDir, filename));
      if (!st.isFile()) {
        unsafe.push(`${filename}: not a regular file`);
        continue;
      }
    } catch (err) {
      unsafe.push(`${filename}: ${(err as NodeJS.ErrnoException).code ?? "lstat failed"}`);
      continue;
    }
    try {
      const endpoint = await readJsonNoFollow(join(endpointsDir, filename), BusEndpointSchema);
      if (filename !== `${endpoint.endpointId}.json`) {
        findings.push(`${filename}: endpoint id does not match filename`);
        continue;
      }
      endpoints.push(endpoint);
    } catch (err) {
      findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { endpoints, findings, unsafe, truncated: candidates.length > ROSTER_SCAN_CAP };
}

function toBusSource(endpoint: BusEndpoint, liveness: "attached" | "offline" | "unknown"): BusSeatSource {
  return {
    endpointId: endpoint.endpointId,
    clientTaskId: endpoint.clientTaskId,
    client: endpoint.client,
    joinedAt: endpoint.joinedAt,
    lastSeenAt: endpoint.lastSeenAt,
    lastWakeAt: endpoint.lastWakeAt ?? null,
    retiredAt: endpoint.retiredAt,
    liveness,
  };
}

/**
 * Reads the roster and, when the project's Bus feature is on, merges its
 * endpoints in by identity. The liveness probe runs only for endpoints that
 * are not retired and only up to the scan cap; a retired endpoint is never
 * evidence of a seat, so its process is not inspected. A Bus read failure is
 * reported as a diagnostic and the mod seats are returned on their own.
 */
export async function readRosterWithBus(
  root: string,
  config: Config,
  now = Date.now(),
  probe: LivenessProbe = endpointLiveness,
): Promise<BusRosterView> {
  const base = readRoster(root, now);
  if (!isBusEnabled(config)) return { ...base, busScanTruncated: false };
  let endpoints: BusEndpoint[];
  let busScanTruncated = false;
  const diagnostics = [...base.diagnostics];
  const uncertainty: RosterReadUncertainty[] = [...(base.readUncertainty ?? [])];
  try {
    // The feature flag alone is not a runtime: a project that turned the Bus
    // on but never ran `storybloq bus setup` has no endpoints directory, and
    // that is said rather than read as "no endpoints".
    const paths = await resolveBusPaths(root, false);
    if (!existsSync(paths.endpoints)) {
      diagnostics.push("bus runtime not initialised (no endpoints directory); Bus seats not merged");
      return { ...base, diagnostics, busScanTruncated: false };
    }
    const listed = await listEndpointsBounded(paths.endpoints);
    endpoints = listed.endpoints;
    busScanTruncated = listed.truncated;
    for (const finding of listed.findings.slice(0, 8)) diagnostics.push(`bus endpoint skipped: ${finding}`);
    for (const finding of [...listed.findings, ...listed.unsafe]) uncertainty.push({ source: "bus-endpoint", cause: finding });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    diagnostics.push(`bus endpoints unreadable: ${cause}`);
    uncertainty.push({ source: "bus-endpoints", cause });
    return { ...base, diagnostics, busScanTruncated: false, readUncertainty: uncertainty };
  }
  const probeUnknown = (endpoint: BusEndpoint, cause: string) =>
    uncertainty.push({ source: "bus-probe", cause, identity: { client: endpoint.client, clientTaskId: endpoint.clientTaskId }, endpointId: endpoint.endpointId });
  const sources = await Promise.all(
    endpoints.map(async (endpoint) => {
      if (endpoint.retiredAt !== null) return toBusSource(endpoint, "unknown");
      try {
        const liveness = await probe(endpoint);
        if (liveness === "unknown") probeUnknown(endpoint, "unknown");
        return toBusSource(endpoint, liveness);
      } catch {
        probeUnknown(endpoint, "probe threw");
        return toBusSource(endpoint, "unknown");
      }
    }),
  );
  const merged = mergeBusSeats(base.seats, sources, now);
  const view = summarizeRoster(merged.seats, {
    scanTruncated: base.scanTruncated,
    resultTruncated: base.resultTruncated || merged.resultTruncated,
    diagnostics,
    uncertainty,
  });
  return { ...view, busScanTruncated };
}

/** Running seats only, labelled; the counts are the view's own (terminal included). */
export function statusRosterFrom(view: RosterView | BusRosterView, node: string | null): StatusRoster {
  return {
    seats: view.seats.filter((s) => s.state === "running").map((s) => ({ ...s, node })),
    live: view.live,
    stale: view.stale,
    terminal: view.terminal,
    scanTruncated: view.scanTruncated,
    resultTruncated: view.resultTruncated,
    busScanTruncated: "busScanTruncated" in view ? view.busScanTruncated : false,
    diagnostics: view.diagnostics,
  };
}

/** The empty roster: what status carries when a project has no roster directory at all. */
export function emptyStatusRoster(): StatusRoster {
  return { seats: [], live: 0, stale: 0, terminal: 0, scanTruncated: false, resultTruncated: false, busScanTruncated: false, diagnostics: [] };
}

/**
 * A node's config, read leniently: only `features.bus` matters here, and an
 * unreadable config means the Bus is not consulted for that node (said so in
 * a diagnostic), never that the node's roster records are skipped.
 */
function nodeConfig(storyDir: string): { config: Config | null; problem: string | null } {
  try {
    // Bounded, no-follow: a node's config is another repository's file; a
    // symlink, a FIFO or an oversized file is a diagnostic, never a hang.
    const text = readBoundedNoFollow(join(storyDir, "config.json"), NODE_CONFIG_MAX_BYTES);
    if (text === null) return { config: null, problem: "config.json is missing, not a regular file, or exceeds the size bound" };
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, problem: "config.json is not an object" };
    const features = (raw as { features?: unknown }).features;
    const config = { features: features && typeof features === "object" ? features : {} } as unknown as Config;
    return { config, problem: null };
  } catch (err) {
    return { config: null, problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The orchestrator's roster plus every resolved node's, each seat labelled
 * with its node (null for the orchestrator itself), sorted newest first and
 * bounded to `ROSTER_RESULT_CAP` overall with the cut reported. A node that
 * did not resolve, or whose roster read failed, is one diagnostic line.
 */
export async function readFederatedRoster(
  root: string,
  config: Config,
  nodes: ReadonlyMap<string, ResolvedNode>,
  now = Date.now(),
  probe: LivenessProbe = endpointLiveness,
): Promise<StatusRoster> {
  const seats: StatusRosterSeat[] = [];
  const diagnostics: string[] = [];
  let live = 0;
  let stale = 0;
  let terminal = 0;
  let scanTruncated = false;
  let resultTruncated = false;
  let busScanTruncated = false;
  const fold = (view: RosterView | BusRosterView, node: string | null): void => {
    const s = statusRosterFrom(view, node);
    seats.push(...s.seats);
    live += s.live;
    stale += s.stale;
    terminal += s.terminal;
    scanTruncated ||= s.scanTruncated;
    resultTruncated ||= s.resultTruncated;
    busScanTruncated ||= s.busScanTruncated;
    for (const d of s.diagnostics) diagnostics.push(node === null ? d : `${node}: ${d}`);
  };
  try {
    fold(await readRosterWithBus(root, config, now, probe), null);
  } catch (err) {
    diagnostics.push(`roster unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const [name, node] of nodes) {
    if (!node.resolved) {
      diagnostics.push(`${name}: node not resolved (${node.reason}), roster not read`);
      continue;
    }
    const { config: nodeCfg, problem } = nodeConfig(node.storyDir);
    if (problem !== null) diagnostics.push(`${name}: config unreadable (${problem}), Bus not consulted`);
    try {
      const view = nodeCfg === null ? readRoster(node.absolutePath, now) : await readRosterWithBus(node.absolutePath, nodeCfg, now, probe);
      fold(view, name);
    } catch (err) {
      diagnostics.push(`${name}: roster unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const sorted = seats.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.seatId.localeCompare(b.seatId));
  return {
    seats: sorted.slice(0, ROSTER_RESULT_CAP),
    live,
    stale,
    terminal,
    scanTruncated,
    resultTruncated: resultTruncated || sorted.length > ROSTER_RESULT_CAP,
    busScanTruncated,
    diagnostics,
  };
}
