/**
 * Which MCP servers are alive for this project (T-450, ruling C).
 *
 * WHY THIS EXISTS. A session records the pid of the MCP server that last served
 * it. When that server exits, its alive sidecar writes a death marker. But an
 * ordinary MCP restart produces exactly that state while the owner task lives
 * on, and the recorded pid is then definitively dead, so the recorded pid alone
 * cannot tell "the owner's whole client went away" from "the server bounced and
 * the owner has not made a guide call since".
 *
 * The missing half is the SUCCESSOR: if some other MCP server is alive for this
 * project, a death marker attributable to an older server has been superseded
 * and must not authorize anything. That is the case a recorded-pid check
 * structurally cannot see, because the successor never touched this session.
 *
 * Entries are pid-named files under `.story/servers/`, written at server start
 * and removed at exit. A crashed server leaves a stale entry, which is why
 * liveness is always re-probed rather than trusted from the file's existence.
 *
 * TRUST: same posture as the rest of this machinery. Ordinary workspace files,
 * corruption-resistant rather than forgery-resistant, and every ambiguity
 * resolves toward NOT offering.
 */
import * as fs from "node:fs";
import { join } from "node:path";

const SERVERS_DIRNAME = "servers";

/**
 * Observed successors, or an explicit statement that we could not look.
 *
 * `unavailable` is NOT the same as an empty `pids`. Empty means "we enumerated
 * and nothing else is running", which permits a candidate. `unavailable` means
 * the registry could not be read, so a successor can be neither confirmed nor
 * ruled out, and the offer must be suppressed.
 */
export interface RegisteredServer {
  readonly pid: number;
  /**
   * When this server registered. Load bearing, not decorative: "some other
   * server is alive" is NOT supersession. A second client's server that has
   * been running since before the recorded server was last serving proves
   * nothing about that server's death, and treating it as a successor would
   * suppress recovery forever on any machine running two clients against one
   * project.
   *
   * The comparison anchor is the recorded server's LAST GUIDE CALL, not the
   * death marker. Anchoring on the marker looks more natural and is wrong: a
   * replacement server registers the moment it starts, while the dying server's
   * sidecar writes its marker up to a full tick later, so a genuine successor
   * routinely predates the marker it superseded. The last guide call is the
   * latest instant the recorded server is known to have been serving, which is
   * the bound that actually holds. See `readMarkerValidity` in `liveness.ts`.
   *
   * Null when the entry exists but its timestamp could not be read or parsed,
   * which makes the comparison impossible and therefore suppresses.
   */
  readonly registeredAt: string | null;
}

export type SuccessorServers =
  | { readonly kind: "observed"; readonly servers: readonly RegisteredServer[] }
  | { readonly kind: "unavailable"; readonly reason: string };

function serversDir(root: string): string {
  return join(root, ".story", SERVERS_DIRNAME);
}

/**
 * Roots this process is a live server for but FAILED to register in.
 *
 * The reader-side checks below catch the failures that are visible from the
 * filesystem: a missing directory, an unreadable one, an unwritable one. They
 * do NOT catch a failure that leaves the directory perfectly readable and
 * writable to everyone else while this process's own write happened to fail,
 * such as a transient ENOSPC or a lost race. Enumeration would then report
 * `observed` without this server in it, a predecessor's session would see no
 * successor, and it would reach `gone-candidate` while this very process is
 * the successor. Recording the failure locally answers `unavailable` instead.
 *
 * It is process-local, so it protects only evaluations made HERE. That is a
 * real limit, not an oversight: see the residual window documented in
 * `mcp-binding.ts`.
 */
const unregisteredRoots = new Set<string>();

/** Note that this process is serving `root` without a registry entry. */
export function markRegistryUnavailable(root: string): void {
  unregisteredRoots.add(root);
}

/** Clear the flag once registration finally succeeds. */
export function clearRegistryUnavailable(root: string): void {
  unregisteredRoots.delete(root);
}

/** Record this process as a live MCP server for `root`. Best effort. */
export function registerMcpServer(root: string, pid: number = process.pid): boolean {
  try {
    const dir = serversDir(root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(dir, String(pid)), new Date().toISOString());
    unregisteredRoots.delete(root);
    return true;
  } catch {
    // Never throws: the MCP server must keep serving without a registry. The
    // BOOLEAN is the point though. A silent failure that the caller records as
    // a successful bind is worse than no registry at all, because the caller
    // then stops retrying and marks this process registered, so it stamps its
    // pid onto sessions while absent from the listing. Returning false is what
    // lets the binder flag the root, decline the registered role, and retry.
    unregisteredRoots.add(root);
    return false;
  }
}

/** Remove this process's registry entry. Best effort. */
export function unregisterMcpServer(root: string, pid: number = process.pid): void {
  try { fs.unlinkSync(join(serversDir(root), String(pid))); }
  catch { /* already gone, or never written */ }
}

/**
 * Enumerate live MCP servers for `root`, reaping stale entries as it goes.
 *
 * Every outcome that is not a complete enumeration is `unavailable`, including
 * a MISSING directory. That is deliberate and is the opposite of the obvious
 * reading: absence looks like "nothing is running", but any healthy server
 * creates this directory by registering, so absence instead means no server
 * ever registered here, and a live-but-unlisted server would go unseen. The
 * cost is that a project which has never run a registering server suppresses
 * offers until one does, which is the safe direction.
 */
export function liveMcpServers(root: string): SuccessorServers {
  // This process is a live server for `root` and is NOT in the listing, so the
  // listing cannot be read as complete no matter what it contains.
  if (unregisteredRoots.has(root)) {
    return { kind: "unavailable", reason: "this server could not register itself" };
  }
  const dir = serversDir(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (e: any) {
    // ENOENT is NOT "nothing is running". Any healthy server creates this
    // directory by registering, and the process asking is normally one of
    // them, so its absence means no server ever registered here. Reporting an
    // empty listing would let a live but unlisted server go unseen, which is
    // the cross-process half of the same fail-open the local flag guards.
    if (e && e.code === "ENOENT") {
      return { kind: "unavailable", reason: "registry directory does not exist" };
    }
    return { kind: "unavailable", reason: `registry unreadable (${e?.code ?? "error"})` };
  }

  // Writability is observable by ANY reader, which is what makes it useful:
  // a local "I failed to register" flag cannot be seen by another process, but
  // a directory no one can write to explains why a live server might be
  // missing from the listing, whichever process is asking.
  try {
    const probe = join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (e: any) {
    return { kind: "unavailable", reason: `registry not writable (${e?.code ?? "error"})` };
  }

  const servers: RegisteredServer[] = [];
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue; // skips .probe-* and anything foreign
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e && e.code === "ESRCH") {
        try { fs.unlinkSync(join(dir, name)); } catch { /* another process reaped it */ }
        continue;
      }
      // EPERM means something occupies the pid under another uid. It cannot be
      // our server, but it is not provably absent either, so keep it: the
      // consequence is suppressing an offer, which is the safe direction.
      if (!e || e.code !== "EPERM") {
        // Probe failed for an unexpected reason: we cannot classify this entry,
        // and guessing either way is worse than admitting it.
        return { kind: "unavailable", reason: `pid probe failed (${e?.code ?? "error"})` };
      }
    }
    let registeredAt: string | null = null;
    try {
      const raw = fs.readFileSync(join(dir, name), "utf-8").trim();
      registeredAt = Number.isNaN(new Date(raw).getTime()) ? null : raw;
    } catch { registeredAt = null; }
    servers.push({ pid, registeredAt });
  }
  return { kind: "observed", servers };
}
