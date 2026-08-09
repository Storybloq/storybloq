import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { normalizeClientTaskId, type StorybloqClient } from "../autonomous/client-profile.js";
import { loadProject } from "../core/project-loader.js";
import { resolveInitializedBusPaths, resolveInitializedBusPathsForJoin } from "./admin.js";
import { canonicalHash, sha256 } from "./canonical.js";
import { assertBusEnabled } from "./config.js";
import { BusError } from "./errors.js";
import { durableCreate, durableUnlink, durableWrite, listRegularJsonFiles, readJsonNoFollow, rejectPathSymlink, syncDirectory } from "./io.js";
import { acquireHardenedLock, captureProcessSignature, inspectProcessIdentity, releaseHardenedLock, withHardenedLock } from "./lock.js";
import { assertBusLayout, endpointMailboxPath, resolveBusPaths, type BusPaths } from "./paths.js";
import { normalizeBusText } from "./security.js";
import {
  BusEndpointSchema,
  BusSuccessionSchema,
  type BusClient,
  type BusEndpoint,
  type BusProcessRef,
  type BusSuccession,
  type BusSurface,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const SUCCESSION_TTL_MS = 15 * 60 * 1000;
const ENDPOINT_LOCK_TIMEOUT_MS = 15_000;
const EndpointIdSchema = z.string().uuid();
const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;

// Remove empty orphan mailboxes left by a join that was interrupted AFTER the new
// mailbox dir was created but BEFORE the endpoint record was committed. Such a crash
// leaves a UUID-named mailbox dir with no endpoint record; this reclaims it so it
// cannot accumulate as litter (or, on a build where the layout assertion flags
// orphans, brick subsequent joins). Only an orphan with ZERO pointers in its root and
// pending/ is removed: a non-empty orphan holds unread mail addressed to a deleted
// endpoint and is left for `bus doctor` to report rather than silently discarded.
// Must be called under endpoints.lock so no concurrent join can create the matching
// record between the no-record check and the remove. A symlinked or non-directory
// entry is left untouched (no traversal, caught later by mkdir/assertBusLayout).
// An orphan mailbox is safe to reclaim ONLY when it is provably empty: its root holds
// exactly a real (non-symlink) `pending` directory and nothing else, and pending/ is
// itself empty. ANY other state -- a mailbox pointer, counter.json, a hidden/renamed/
// symlinked file, a nested directory, or an enumeration failure -- means the orphan may
// hold unread mail or corruption evidence, so it is PRESERVED for `bus doctor` rather
// than deleted. Fails closed (returns false) on any inability to prove emptiness.
async function orphanIsProvablyEmpty(orphan: string): Promise<boolean> {
  let rootEntries;
  try {
    rootEntries = await readdir(orphan, { withFileTypes: true });
  } catch {
    return false;
  }
  const meaningful = rootEntries.filter((entry) => entry.name !== "." && entry.name !== "..");
  if (meaningful.length !== 1) return false;
  const only = meaningful[0]!;
  if (only.name !== "pending" || !only.isDirectory() || only.isSymbolicLink()) return false;
  let pendingEntries;
  try {
    pendingEntries = await readdir(join(orphan, "pending"), { withFileTypes: true });
  } catch {
    return false;
  }
  return pendingEntries.every((entry) => entry.name === "." || entry.name === "..");
}

async function removeEmptyOrphanMailboxes(
  paths: BusPaths,
  registeredEndpointIds: ReadonlySet<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(paths.mailboxes, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !EndpointIdSchema.safeParse(entry.name).success || registeredEndpointIds.has(entry.name)) {
      continue;
    }
    const orphan = endpointMailboxPath(paths, entry.name);
    // Guard against symlink traversal before the recursive remove.
    await rejectPathSymlink(orphan);
    // Reclaim ONLY a provably-empty orphan. A pointer regex over listRegularJsonFiles
    // would treat a renamed/hidden/symlinked pointer (or a counter.json, nested dir, or
    // enumeration error) as "empty" and `rm` it, destroying unread mail or corruption
    // evidence doctor should report. Preserve on anything but an empty real pending dir.
    if (!(await orphanIsProvablyEmpty(orphan))) continue;
    await rm(orphan, { recursive: true, force: true });
    await syncDirectory(paths.mailboxes);
  }
}

// ISS-940: removes the mailbox created during joinEndpoint's unlocked prep when a
// later, routine failure inside the replace path's inner-lock tail (acquisition
// error, a fresh conflict re-check, or a propagated read error) means the new
// endpoint's own record will never be created. The mailbox is provably unregistered
// at every one of those exits (the endpoints/<id>.json durableCreate for it is never
// reached), so this mirrors removeEmptyOrphanMailboxes' own safety bar rather than a
// bare recursive removal: reject a symlinked mailbox path, and remove only a mailbox
// proven empty via the same orphanIsProvablyEmpty check the crash-recovery sweep
// already uses. Best-effort: every call site swallows errors from this function so a
// cleanup failure can never mask the real error being thrown; an unremoved mailbox in
// that rare case still self-heals via removeEmptyOrphanMailboxes on the next join.
async function cleanupOrphanMailbox(paths: BusPaths, endpointId: string): Promise<void> {
  const orphan = endpointMailboxPath(paths, endpointId);
  await rejectPathSymlink(orphan);
  if (!(await orphanIsProvablyEmpty(orphan))) return;
  await rm(orphan, { recursive: true, force: true });
  await syncDirectory(paths.mailboxes);
}

export interface ProcessCandidate {
  readonly pid: number;
  readonly command: string;
}

async function processCandidate(pid: number): Promise<ProcessCandidate | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 500 });
      const command = stdout.trim();
      return command ? { pid, command } : null;
    }
    if (process.platform === "linux") {
      const handle = await import("node:fs/promises").then((fs) => fs.open(`/proc/${pid}/cmdline`, "r"));
      let command: string;
      try { command = (await handle.readFile("utf-8")).replace(/\0/g, " ").trim(); } finally { await handle.close(); }
      return command ? { pid, command } : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function parentPid(pid: number): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: 500 });
      const parsed = Number(stdout.trim());
      return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
    }
    if (process.platform === "linux") {
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(`/proc/${pid}/stat`, "utf-8"));
      const rightParen = raw.lastIndexOf(")");
      const fields = rightParen >= 0 ? raw.slice(rightParen + 1).trim().split(/\s+/) : [];
      const parsed = Number(fields[1]);
      return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function findClientProcess(client: BusClient): Promise<{ surface: BusSurface | null; process: ProcessCandidate | null }> {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const candidate = await processCandidate(pid);
    const command = candidate?.command ?? "";
    if (client === "codex" && /(?:^|[/ ])codex(?: |$)/i.test(command)) {
      return {
        surface: /\bapp-server\b/.test(command) ? "codex_desktop" : "codex_cli",
        process: candidate,
      };
    }
    if (client === "claude" && /(?:^|[/ ])claude(?: |$)/i.test(command)) {
      return { surface: "claude_cli", process: candidate };
    }
    const next = await parentPid(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return { surface: client === "claude" ? "claude_cli" : null, process: null };
}

/** Best-effort client surface detection from process ancestry (marker hint). */
export async function detectClientSurface(client: BusClient): Promise<BusSurface | null> {
  return (await findClientProcess(client)).surface;
}

// Test-only seam (ISS-940): findClientProcess scans real OS process ancestry and
// ignores clientTaskId, so its outcome is environment-dependent -- not something a
// test can rely on deterministically. When set, this override replaces ONLY the
// detection step at refreshEndpointForSessionStart's call site; the downstream
// surface-validation and processRefFor logic built on top of the detection result is
// untouched. Null in production (never in the refresh path's cost).
let processDetectionOverride:
  | ((client: BusClient) => Promise<{ surface: BusSurface | null; process: ProcessCandidate | null }>)
  | null = null;

async function detectClientProcess(client: BusClient): Promise<{ surface: BusSurface | null; process: ProcessCandidate | null }> {
  if (processDetectionOverride) return processDetectionOverride(client);
  return findClientProcess(client);
}

// Test-only seams (ISS-940), both null in production. afterEndpointReadHook fires in
// withEndpointLock immediately after its locked read, before the handler runs -- used
// to pause the refresh side mid-critical-section. afterReplaceReadHook fires in
// joinEndpoint's replace branch immediately after its fresh re-read under the inner
// lock, before the liveness re-check -- used to pause the replace side. Both take the
// endpointId so a shared installed hook can filter to the endpoint under test.
let afterEndpointReadHook: ((endpointId: string) => Promise<void>) | null = null;
let afterReplaceReadHook: ((endpointId: string) => Promise<void>) | null = null;

async function gitOutput(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitBinding(root: string): Promise<{ branch: string | null; worktreeId: string }> {
  const commonDir = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const branch = await gitOutput(root, ["symbolic-ref", "--short", "HEAD"]);
  return {
    branch,
    worktreeId: canonicalHash({ root, commonDir: commonDir ?? root, gitDir: gitDir ?? root }),
  };
}

async function processRefFor(surface: BusSurface, candidate: ProcessCandidate | null): Promise<BusProcessRef | null> {
  if (surface === "codex_desktop" || !candidate) return null;
  const signature = await captureProcessSignature(candidate.pid);
  return signature
    ? { pid: candidate.pid, signature, capturedAt: new Date().toISOString() }
    : null;
}

export async function listEndpoints(root: string): Promise<{ endpoints: BusEndpoint[]; findings: string[] }> {
  const paths = await resolveBusPaths(root, false);
  const endpoints: BusEndpoint[] = [];
  const findings: string[] = [];
  for (const filename of await listRegularJsonFiles(paths.endpoints)) {
    try {
      const endpoint = await readJsonNoFollow(join(paths.endpoints, filename), BusEndpointSchema);
      if (filename !== `${endpoint.endpointId}.json`) {
        findings.push(`${filename}: endpoint id does not match filename`);
        continue;
      }
      endpoints.push(endpoint);
    } catch (err) {
      findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { endpoints, findings };
}

export async function findEndpointForTask(
  root: string,
  client: BusClient,
  clientTaskId: string,
): Promise<BusEndpoint | null> {
  const normalized = normalizeClientTaskId(clientTaskId);
  if (!normalized) return null;
  const { endpoints } = await listEndpoints(root);
  return endpoints.find((endpoint) =>
    !endpoint.retiredAt && endpoint.client === client && endpoint.clientTaskId === normalized,
  ) ?? null;
}

// ISS-872: a successor's bounded predecessor-chain walk is capped so a corrupt
// on-disk record can never make the read seams loop or trust an unbounded lineage.
// Rare in normal operation, not unreachable (ISS-953 Codex round 5 finding #3):
// each hop requires a proven-offline replacement, but a legitimate chain of 65
// sequential replacements over a long enough timeline is structurally reachable,
// just uncommon; the cap deliberately fails closed for unusually deep or corrupt
// lineages either way.
const MAX_SUCCESSION_DEPTH = 64;

// ISS-872: the set of recipient ids whose mail this endpoint may read/ack/administer
// -- its own id plus its bounded predecessor CHAIN (the endpoint it replaced, that
// endpoint's predecessor, ...). Authority propagates transitively across repeated
// replacement (B->S->T) so a second replacement does not re-strand the original
// recipient's mail (T must inherit B, not just S). A successor LEAVING without a
// replacement is out of scope here (the deferred all-participants-retired case, ISS-873).
// Pure over the already-loaded endpoint list (no I/O); every caller already has the
// list. Security-sensitive:
// a corrupt chain (cycle, missing ancestor, or over-depth) must NEVER grant
// authority, so it fails CLOSED to self-only and reports `corrupt` for the caller
// (doctor) to surface. Used by the read/ack/administer seams and by
// verifiedSuccessorState's authorship binding (ISS-953 fix), never send/reply.
export function endpointAddressees(
  endpoint: BusEndpoint,
  allEndpoints: readonly BusEndpoint[],
): { ids: string[]; corrupt: string | null } {
  const byId = new Map(allEndpoints.map((candidate) => [candidate.endpointId, candidate]));
  const ids: string[] = [endpoint.endpointId];
  const visited = new Set<string>([endpoint.endpointId]);
  let current: BusEndpoint = endpoint;
  let depth = 0;
  while (current.predecessorEndpointId) {
    const predecessorId = current.predecessorEndpointId;
    if (visited.has(predecessorId)) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain cycles at ${predecessorId}` };
    }
    if (++depth > MAX_SUCCESSION_DEPTH) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain exceeds max depth ${MAX_SUCCESSION_DEPTH}` };
    }
    const ancestor = byId.get(predecessorId);
    // A retired ancestor keeps its record (retire only sets retiredAt), so a MISSING
    // ancestor means a deleted/tampered endpoint file -- corruption, not a normal end
    // of chain. Fail closed rather than silently truncate the inherited authority.
    if (!ancestor) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain references missing ancestor ${predecessorId}` };
    }
    // A legitimate predecessor was retired specifically BY replacement (joinEndpoint
    // stamps retiredReason "replaced"). A link to an ACTIVE endpoint, or to one retired
    // by `leave` or forced retirement, is NOT a real succession and must never grant
    // authority over that endpoint's mail/threads -- fail closed to self-only. This is a
    // security boundary: UUID existence alone cannot establish inherited authority.
    if (!ancestor.retiredAt || ancestor.retiredReason !== "replaced") {
      return { ids: [endpoint.endpointId], corrupt: `predecessor ${predecessorId} was not retired by replacement` };
    }
    visited.add(predecessorId);
    ids.push(predecessorId);
    current = ancestor;
  }
  return { ids, corrupt: null };
}

export async function endpointLiveness(endpoint: BusEndpoint): Promise<"attached" | "offline" | "unknown"> {
  if (endpoint.surface === "codex_desktop" || !endpoint.processRef) return "unknown";
  const state = await inspectProcessIdentity(endpoint.processRef.pid, endpoint.processRef.signature);
  return state === "alive" ? "attached" : state === "dead" ? "offline" : "unknown";
}

export async function refreshEndpointForSessionStart(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<BusEndpoint> {
  const endpoint = await assertEndpointCaller(root, endpointId, clientTaskId);
  const detected = await detectClientProcess(endpoint.client);
  if (detected.process && detected.surface && detected.surface !== endpoint.surface) {
    throw new BusError("conflict", `Endpoint surface changed from ${endpoint.surface} to ${detected.surface}`);
  }
  const processRef = await processRefFor(
    endpoint.surface,
    detected.surface === endpoint.surface ? detected.process : null,
  );
  return withEndpointCaller(root, endpoint.endpointId, clientTaskId, async (_current, persist) =>
    persist((current) => ({
      ...current,
      processRef,
      state: processRef ? "attached" : "unknown",
      lastSeenAt: new Date().toISOString(),
    })),
  );
}

export interface JoinEndpointInput {
  readonly client: StorybloqClient;
  readonly clientTaskId: string;
  readonly surface?: BusSurface;
  /** Endpoint id of a positively-proven-offline incumbent to replace. */
  readonly replace?: string;
}

const EndpointIdInputSchema = z.string().uuid();

export async function joinEndpoint(root: string, input: JoinEndpointInput): Promise<{ endpoint: BusEndpoint; existing: boolean }> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId) throw new BusError("invalid_input", "A valid client task id is required to join the Bus");
  // An explicit surface inherently incompatible with the client (claude must be
  // claude_cli; codex is never claude_cli) is invalid_input regardless of process
  // ancestry AND regardless of whether this is a new join or a same-task rejoin.
  // Checked before the runtime is touched so the contract holds on every path,
  // including the same-task early return and heal below.
  if (input.surface && ((input.client === "claude" && input.surface !== "claude_cli") ||
      (input.client === "codex" && input.surface === "claude_cli"))) {
    throw new BusError("invalid_input", `Surface ${input.surface} is not valid for the ${input.client} client`);
  }
  assertBusEnabled((await loadProject(root)).state.config);
  // Join uses the base-runtime resolution rather than the full-layout assertion so
  // it can reach and heal a missing endpoint mailbox/pending child. The strict
  // resolveInitializedBusPaths runs assertBusLayout up front, which requires every
  // endpoint's pending dir and would throw `corrupt` before the heal code below
  // could run. Every return path re-runs assertBusLayout AFTER the heal/creation so
  // full-layout validation still happens once the layout is whole again.
  const paths = await resolveInitializedBusPathsForJoin(root);
  return withHardenedLock(join(paths.locks, "endpoints.lock"), async () => {
    const listed = await listEndpoints(paths.projectRoot);
    if (listed.findings.length > 0) {
      throw new BusError("corrupt", `Endpoint registry is corrupt: ${listed.findings[0]}`);
    }
    // Same-task rejoin returns the existing endpoint (role is per-message now).
    const sameTask = listed.endpoints.find((endpoint) =>
      !endpoint.retiredAt && endpoint.client === input.client && endpoint.clientTaskId === taskId,
    );
    if (sameTask) {
      // Heal a mailbox dir lost to a crash (e.g. mid-join on an older build) so
      // endpoint-scoped ops do not brick against assertBusLayout. Run this
      // unconditionally rather than only when the mailbox root is absent: a
      // partial crash can leave the mailbox root present while its required
      // pending child is gone, and a root-existence check would then skip the
      // heal and let assertBusLayout keep rejecting every endpoint-scoped op.
      // mkdir recursive is a no-op when the pending child already exists, so
      // this stays cheap on the common healthy path.
      const mailbox = endpointMailboxPath(paths, sameTask.endpointId);
      // Guard the relaxed-resolution heal against symlink traversal. The join-scoped
      // resolver deliberately skips per-endpoint mailbox validation so this heal can
      // run, so a tampered runtime could point mailboxes/<id> or its pending child at
      // an external directory; the recursive mkdir below would then follow the symlink
      // and create/write OUTSIDE .story/bus before assertBusLayout (which runs only
      // afterward) could reject it. Path-string containment does not stop symlink
      // traversal, so lstat each path without following it and fail closed on a symlink.
      // rejectPathSymlink tolerates a genuinely absent path (the heal case); non-symlink
      // corruption (a regular file where a dir belongs) causes no traversal and is caught
      // by mkdir/assertBusLayout.
      await rejectPathSymlink(mailbox);
      await rejectPathSymlink(join(mailbox, "pending"));
      await mkdir(join(mailbox, "pending"), { recursive: true, mode: 0o700 });
      await syncDirectory(mailbox);
      await syncDirectory(paths.mailboxes);
      // The heal restored this endpoint's mailbox/pending child, so the full
      // layout is whole again: run the strict assertion now (after the heal) to
      // recover the validation the join-scoped resolution deliberately skipped.
      await assertBusLayout(paths);
      return { endpoint: sameTask, existing: true };
    }

    // Validate a --replace incumbent (positively-proven-offline, keeping the v1
    // rule) without mutating anything yet. The retire write is deferred below
    // until every fallible check has passed so a later throw cannot leave the
    // incumbent retired with no replacement.
    let replaceIncumbent: BusEndpoint | null = null;
    if (input.replace) {
      if (!EndpointIdInputSchema.safeParse(input.replace).success) {
        throw new BusError("invalid_input", "Invalid endpoint id for --replace");
      }
      const incumbent = listed.endpoints.find(
        (endpoint) => !endpoint.retiredAt && endpoint.endpointId === input.replace,
      );
      if (!incumbent) {
        throw new BusError("not_found", "No active endpoint matches the --replace id");
      }
      const liveness = await endpointLiveness(incumbent);
      if (liveness !== "offline") {
        throw new BusError(
          "conflict",
          `Endpoint ${incumbent.endpointId} is ${liveness}. Replacement requires positive offline proof.`,
        );
      }
      replaceIncumbent = incumbent;
    }

    // Two-endpoint invariant: at most two active (non-retired) endpoints.
    const activeAfterReplace = listed.endpoints.filter(
      (endpoint) => !endpoint.retiredAt && endpoint.endpointId !== input.replace,
    );
    if (activeAfterReplace.length >= 2) {
      throw new BusError(
        "conflict",
        "The Bus already has two active endpoints. Run `storybloq bus setup --replace <endpoint-id>` with a proven-offline incumbent to take its place.",
      );
    }

    const detected = await findClientProcess(input.client);
    if (input.surface && detected.process && detected.surface && input.surface !== detected.surface) {
      throw new BusError(
        "conflict",
        `Requested ${input.surface} does not match the detected ${detected.surface} client process`,
      );
    }
    const surface = input.surface ?? detected.surface;
    if (!surface || (input.client === "claude" && surface !== "claude_cli") ||
        (input.client === "codex" && surface === "claude_cli")) {
      throw new BusError("invalid_input", "Cannot determine the client surface safely; pass --surface explicitly");
    }

    // Prepare every fallible, non-registry-mutating step BEFORE the incumbent
    // retire write, so a throw or crash in preparation cannot leave the
    // incumbent retired with no committed replacement. Resolve the git/process
    // binding, construct the full endpoint record, and create + fsync the
    // replacement mailbox here; the only work left after this point is the two
    // registry mutations (retire write, then replacement create), performed
    // back to back with no fallible step between them.
    const binding = await gitBinding(paths.projectRoot);
    const processRef = await processRefFor(
      surface,
      detected.surface === surface ? detected.process : null,
    );
    const now = new Date().toISOString();
    const endpoint: BusEndpoint = BusEndpointSchema.parse({
      schema: "storybloq-bus-endpoint/v2",
      endpointId: randomUUID(),
      client: input.client,
      surface,
      clientTaskId: taskId,
      resumeHandle: taskId,
      projectRoot: paths.projectRoot,
      gitBranch: binding.branch,
      worktreeId: binding.worktreeId,
      processRef,
      state: processRef ? "attached" : "unknown",
      joinedAt: now,
      lastSeenAt: now,
      wakePolicy: "never",
      lastPolledMailboxSeq: 0,
      lastBlockedMailboxSeq: 0,
      // ISS-872: annotate the successor with the incumbent it replaced so the
      // read/ack/administer seams redeliver the incumbent's undelivered mail and
      // accept this successor's authority over its inherited threads. Only one
      // hop is recorded here; the incumbent's own predecessor is never copied
      // (the transitive chain is walked at read time by endpointAddressees).
      ...(replaceIncumbent ? { predecessorEndpointId: replaceIncumbent.endpointId } : {}),
      retiredAt: null,
      retiredReason: null,
    });
    // Reclaim any empty orphan mailbox left by a PRIOR join that crashed after its
    // mailbox mkdir but before committing its endpoint record. Done under the held
    // endpoints.lock and before the layout assertion so an interrupted join is
    // recoverable (the next join succeeds) instead of leaving accumulating litter.
    // Registered endpoints (retired or active) keep their mailboxes and are never
    // touched; a non-empty orphan is preserved for doctor to report.
    await removeEmptyOrphanMailboxes(paths, new Set(listed.endpoints.map((candidate) => candidate.endpointId)));
    // Validate the EXISTING layout BEFORE creating the new endpoint's mailbox. If a
    // prior endpoint's mailbox is damaged, asserting only after the mkdir (the
    // previous order) would leave a new orphan mailbox behind when the assertion
    // throws. The join-scoped resolution deliberately skipped this assertion so the
    // same-task heal above could run; the new-endpoint path has no heal, so a new
    // mailbox is created only once the existing layout is known whole.
    await assertBusLayout(paths);
    // The endpoint owns a mailbox created lazily at join. Fsync the new mailbox
    // dir (so its pending child is durable) and its parent (so the mailbox dir
    // entry is durable) before the endpoint record is committed. Otherwise a
    // crash could persist an endpoint whose mailbox dir is gone, which
    // assertBusLayout then rejects as corrupt, bricking every endpoint-scoped op.
    const mailbox = endpointMailboxPath(paths, endpoint.endpointId);
    await mkdir(join(mailbox, "pending"), { recursive: true, mode: 0o700 });
    await syncDirectory(mailbox);
    await syncDirectory(paths.mailboxes);

    // Registry mutation window. Every fallible preparation step is already done,
    // so the retire write and the replacement create run back to back with no
    // fallible work between them, shrinking the crash window to the gap between
    // two durable writes. A crash in that residual gap (incumbent retired, the
    // replacement not yet created) is degraded-but-recoverable, not bricked: if
    // the incumbent was the sole active endpoint the Bus then has zero active
    // endpoints, and re-running `bus setup` performs a fresh same-task join that
    // mints a new endpoint. A full durable-intent transaction is intentionally
    // not used for this pass.
    //
    // ISS-940: this retire write and SessionStart's refresh (which holds
    // endpoint-<id>.lock for its own read-check-write) previously synchronized on
    // disjoint locks, letting a concurrent refresh's unconditional rename clobber a
    // just-landed retire, or vice versa. The replace path now also holds
    // endpoint-<id>.lock around its own decide-and-write, forcing strict ordering
    // against refresh's one continuous hold of that same lock -- mirroring
    // consumeCompactionSuccession's existing outer-endpoints.lock/inner-endpoint-lock
    // nesting. Successor creation happens after the inner lock is released (a NEW
    // file -- durableCreate/link, not a rename over an existing target -- needs no
    // exclusion against the incumbent's lock), gated on an explicit `retired` flag
    // rather than on release succeeding, so a release error can never skip the
    // paired successor write once retire has genuinely committed.
    if (replaceIncumbent) {
      let handle;
      try {
        handle = await acquireHardenedLock(
          join(paths.locks, `endpoint-${replaceIncumbent.endpointId}.lock`),
          { timeoutMs: ENDPOINT_LOCK_TIMEOUT_MS },
        );
      } catch (err) {
        // Every acquisition failure -- not just lock_timeout -- leaves the new
        // endpoint's mailbox from unlocked prep orphaned (no lock was ever
        // acquired, nothing to release, nothing to gate on `retired`). Clean up
        // unconditionally, then decide whether to remap the error.
        await cleanupOrphanMailbox(paths, endpoint.endpointId).catch(() => {});
        if (err instanceof BusError && err.code === "lock_timeout") {
          // A timeout is not positive liveness proof, but --replace requires
          // POSITIVE offline proof; failing to establish exclusive access within
          // this generous window is not that proof either, so refusing is correct
          // regardless of which is true. Maps to conflict (not the generic
          // internal_failure a raw lock_timeout would fall through to in
          // auto-attach.ts) so a detached auto-attach child gets the existing,
          // already-tested race_lost handling.
          throw new BusError(
            "conflict",
            `Endpoint ${replaceIncumbent.endpointId} changed or remained busy while replacement was being verified; retry replacement.`,
          );
        }
        throw err;
      }
      // If durableWrite below throws AMBIGUOUSLY (the retire landed on disk but
      // reporting the write failed), `retired` stays false here, cleanup fires, and
      // the error propagates below -- a genuinely-landed retire with no successor.
      // That is the SAME crash-window outcome the pre-existing back-to-back writes
      // documented above already accept (degraded-but-recoverable via a fresh
      // same-task join). This fix neither narrows nor widens that envelope.
      let retired = false;
      let pendingError: unknown = null;
      try {
        // Fresh re-read under the inner lock -- NEVER reuse `replaceIncumbent`
        // above (captured from the outer-lock-held `listed` snapshot near the top
        // of this function). That snapshot is exactly what a concurrent
        // refreshEndpointForSessionStart could have changed between the outer
        // lock's read and this inner lock's acquisition; deciding from it instead
        // of a fresh read would still be check-then-act. No swallow on this read --
        // schema corruption or an I/O failure must propagate as-is, not collapse
        // into an ordinary conflict.
        const incumbentPath = join(paths.endpoints, `${replaceIncumbent.endpointId}.json`);
        const fresh = await readJsonNoFollow(incumbentPath, BusEndpointSchema);
        if (afterReplaceReadHook) await afterReplaceReadHook(replaceIncumbent.endpointId);
        if (fresh.retiredAt) {
          throw new BusError("conflict", `Endpoint ${replaceIncumbent.endpointId} is no longer an active incumbent.`);
        }
        const liveness = await endpointLiveness(fresh);
        if (liveness !== "offline") {
          throw new BusError(
            "conflict",
            `Endpoint ${fresh.endpointId} changed or remained busy while replacement was being verified; retry replacement.`,
          );
        }
        const retiredAt = new Date().toISOString();
        await durableWrite(incumbentPath, JSON.stringify({
          ...fresh,
          state: "offline",
          retiredAt,
          retiredReason: "replaced",
          lastSeenAt: retiredAt,
        }, null, 2) + "\n");
        retired = true;
      } catch (err) {
        pendingError = err;
      }
      // Deliberately NOT a `finally` -- a release failure can never silently
      // replace `pendingError` (the classic finally-overwrites-the-real-error
      // hazard); its own outcome is captured, not thrown immediately.
      let releaseError: unknown = null;
      try {
        await releaseHardenedLock(handle);
      } catch (err) {
        releaseError = err;
      }
      if (!retired) {
        // Every non-retired exit -- acquisition failure aside, handled above --
        // lands here: already-retired conflict, still-live conflict, or a
        // propagated read/liveness error. One centralized cleanup, strictly after
        // the lock is released.
        await cleanupOrphanMailbox(paths, endpoint.endpointId).catch(() => {});
        // A double-failure (the critical section threw AND release also failed)
        // preserves the release error as supplementary diagnostic data -- must NOT
        // change pendingError's identity/.code, since callers (auto-attach.ts)
        // branch on that exact BusError code. Guarded: attaching a property can
        // itself throw on a frozen/non-extensible object, and that must never mask
        // the primary error thrown unconditionally below.
        if (releaseError && pendingError && typeof pendingError === "object" && Object.isExtensible(pendingError)) {
          try {
            (pendingError as { releaseError?: unknown }).releaseError = releaseError;
          } catch {
            // best-effort only; pendingError is still thrown unmodified below.
          }
        }
        throw pendingError;
      }
      // Retire write committed. Attempt the paired successor write regardless of a
      // release error -- releasing a lock this call no longer needs is orthogonal
      // to the two-file crash doctrine documented above.
      await durableCreate(join(paths.endpoints, `${endpoint.endpointId}.json`), JSON.stringify(endpoint, null, 2) + "\n");
      if (releaseError) throw releaseError;
      return { endpoint, existing: false };
    }
    await durableCreate(join(paths.endpoints, `${endpoint.endpointId}.json`), JSON.stringify(endpoint, null, 2) + "\n");
    return { endpoint, existing: false };
  });
}

export async function assertEndpointCaller(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<BusEndpoint> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  const paths = await resolveInitializedBusPaths(root);
  const endpoint = await readJsonNoFollow(join(paths.endpoints, `${endpointId}.json`), BusEndpointSchema);
  if (endpoint.retiredAt || endpoint.clientTaskId !== taskId) {
    throw new BusError("unauthorized", "Endpoint ownership does not match this task");
  }
  return endpoint;
}

export async function updateEndpoint(
  root: string,
  endpointId: string,
  update: (endpoint: BusEndpoint) => BusEndpoint,
): Promise<BusEndpoint> {
  return withEndpointLock(root, endpointId, async (_endpoint, persist) => persist(update));
}

type EndpointPersist = (update: (endpoint: BusEndpoint) => BusEndpoint) => Promise<BusEndpoint>;

async function withEndpointLock<T>(
  root: string,
  endpointId: string,
  handler: (endpoint: BusEndpoint, persist: EndpointPersist) => Promise<T>,
): Promise<T> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const paths = await resolveInitializedBusPaths(root);
  // Endpoint ownership spans nested thread and mailbox operations whose lock
  // waits can each reach five seconds. The outer acquisition must not expire first.
  return withHardenedLock(join(paths.locks, `endpoint-${endpointId}.lock`), async () => {
    const path = join(paths.endpoints, `${endpointId}.json`);
    let current = await readJsonNoFollow(path, BusEndpointSchema);
    if (afterEndpointReadHook) await afterEndpointReadHook(endpointId);
    const persist: EndpointPersist = async (update) => {
      const next = BusEndpointSchema.parse(update(current));
      await durableWrite(path, JSON.stringify(next, null, 2) + "\n");
      current = next;
      return next;
    };
    return handler(current, persist);
  }, { timeoutMs: ENDPOINT_LOCK_TIMEOUT_MS });
}

export async function withEndpointCaller<T>(
  root: string,
  endpointId: string,
  clientTaskId: string,
  handler: (endpoint: BusEndpoint, persist: EndpointPersist) => Promise<T>,
): Promise<T> {
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  return withEndpointLock(root, endpointId, async (endpoint, persist) => {
    if (endpoint.retiredAt || endpoint.clientTaskId !== taskId) {
      throw new BusError("unauthorized", "Endpoint ownership does not match this task");
    }
    return handler(endpoint, persist);
  });
}

export async function leaveEndpoint(root: string, endpointId: string, clientTaskId: string): Promise<BusEndpoint> {
  return withEndpointCaller(root, endpointId, clientTaskId, async (_endpoint, persist) =>
    persist((current) => {
      const now = new Date().toISOString();
      return { ...current, state: "offline", retiredAt: now, retiredReason: "left", lastSeenAt: now };
    }),
  );
}

export async function retireEndpoint(root: string, endpointId: string, reason: string): Promise<BusEndpoint> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const normalizedReason = normalizeBusText(reason, "Retirement reason", 1024);
  return withEndpointLock(root, endpointId, async (endpoint, persist) => {
    if (await endpointLiveness(endpoint) !== "unknown") {
      throw new BusError("conflict", "Forced retirement is limited to endpoints with unknown liveness");
    }
    return persist((current) => {
      const now = new Date().toISOString();
      return { ...current, state: "offline", retiredAt: now, retiredReason: normalizedReason, lastSeenAt: now };
    });
  });
}

export async function mintCompactionSuccession(input: {
  root: string;
  client: BusClient;
  clientTaskId: string;
  transcriptPath: string;
}): Promise<BusSuccession | null> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId) return null;
  const endpoint = await findEndpointForTask(input.root, input.client, taskId);
  if (!endpoint || !input.transcriptPath) return null;
  const paths = await resolveInitializedBusPaths(input.root);
  const transcriptHash = sha256(input.transcriptPath);
  return withHardenedLock(join(paths.locks, `endpoint-${endpoint.endpointId}.lock`), async () => {
    const now = Date.now();
    for (const { record: existing } of await liveSuccessionRecords(paths.succession, now)) {
      if (existing.endpointId === endpoint.endpointId && existing.kind === "compact" &&
          existing.transcriptHash === transcriptHash && !existing.consumedAt) return existing;
    }
    const createdAt = new Date(now).toISOString();
    const succession: BusSuccession = BusSuccessionSchema.parse({
      schema: "storybloq-bus-succession/v1",
      successionId: randomUUID(),
      endpointId: endpoint.endpointId,
      client: input.client,
      fromTaskId: taskId,
      transcriptHash,
      kind: "compact",
      createdAt,
      expiresAt: new Date(now + SUCCESSION_TTL_MS).toISOString(),
      consumedAt: null,
    });
    await durableCreate(join(paths.succession, `${succession.successionId}.json`), JSON.stringify(succession, null, 2) + "\n");
    return succession;
  });
}

async function liveSuccessionRecords(
  directory: string,
  now: number,
): Promise<Array<{ path: string; record: BusSuccession }>> {
  const records: Array<{ path: string; record: BusSuccession }> = [];
  for (const filename of await listRegularJsonFiles(directory)) {
    try {
      const path = join(directory, filename);
      const record = await readJsonNoFollow(path, BusSuccessionSchema);
      if (filename !== `${record.successionId}.json`) continue;
      if (new Date(record.expiresAt).getTime() <= now) {
        await durableUnlink(path);
        continue;
      }
      records.push({ path, record });
    } catch {
      // Doctor reports malformed records; succession remains fail-closed.
    }
  }
  return records;
}

export async function consumeCompactionSuccession(input: {
  root: string;
  client: BusClient;
  clientTaskId: string;
  transcriptPath: string;
}): Promise<BusEndpoint | null> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId || !input.transcriptPath) return null;
  const paths = await resolveInitializedBusPaths(input.root);
  const transcriptHash = sha256(input.transcriptPath);
  return withHardenedLock(join(paths.locks, "endpoints.lock"), async () => {
    const freshMatches: Array<{ path: string; record: BusSuccession }> = [];
    const retryMatches: Array<{ path: string; record: BusSuccession }> = [];
    const now = Date.now();
    for (const candidate of await liveSuccessionRecords(paths.succession, now)) {
      const record = candidate.record;
      if (record.client !== input.client || record.kind !== "compact" ||
          record.transcriptHash !== transcriptHash) continue;
      if (!record.consumedAt) freshMatches.push(candidate);
      else if (record.toTaskId === taskId) retryMatches.push(candidate);
    }
    if (freshMatches.length > 1) return null;
    let match = freshMatches[0];
    if (!match) {
      const endpointIds = new Set(retryMatches.map((candidate) => candidate.record.endpointId));
      if (endpointIds.size !== 1) return null;
      match = retryMatches.reduce<typeof retryMatches[number] | undefined>((latest, candidate) => {
        if (!latest) return candidate;
        const order = candidate.record.createdAt.localeCompare(latest.record.createdAt) ||
          candidate.record.successionId.localeCompare(latest.record.successionId);
        return order > 0 ? candidate : latest;
      }, undefined);
    }
    if (!match) return null;
    return withHardenedLock(join(paths.locks, `endpoint-${match.record.endpointId}.lock`), async () => {
      const endpointPath = join(paths.endpoints, `${match.record.endpointId}.json`);
      const endpoint = await readJsonNoFollow(endpointPath, BusEndpointSchema);
      const latestRecord = await readJsonNoFollow(match.path, BusSuccessionSchema);
      if (endpoint.retiredAt || endpoint.client !== input.client ||
          latestRecord.successionId !== match.record.successionId) {
        return null;
      }
      if (latestRecord.consumedAt) {
        return latestRecord.toTaskId === taskId && endpoint.clientTaskId === taskId ? endpoint : null;
      }
      if (endpoint.clientTaskId === taskId) {
        await durableWrite(match.path, JSON.stringify({
          ...latestRecord,
          toTaskId: taskId,
          consumedAt: new Date().toISOString(),
        }, null, 2) + "\n");
        return endpoint;
      }
      if (endpoint.clientTaskId !== latestRecord.fromTaskId) return null;
      const refreshed: BusEndpoint = BusEndpointSchema.parse({
        ...endpoint,
        clientTaskId: taskId,
        resumeHandle: taskId,
        lastSeenAt: new Date().toISOString(),
      });
      await durableWrite(endpointPath, JSON.stringify(refreshed, null, 2) + "\n");
      await durableWrite(match.path, JSON.stringify({
        ...latestRecord,
        toTaskId: taskId,
        consumedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      return refreshed;
    });
  });
}

// ISS-940 test-only seams. All null in production (never in any hot path's cost).
export const __testing = {
  // Fires in withEndpointLock immediately after its locked read, before the
  // handler runs. Pass null to clear.
  setAfterEndpointReadHook(hook: ((endpointId: string) => Promise<void>) | null): void {
    afterEndpointReadHook = hook;
  },
  // Fires in joinEndpoint's replace branch immediately after its fresh re-read
  // under the inner lock, before the liveness re-check. Pass null to clear.
  setAfterReplaceReadHook(hook: ((endpointId: string) => Promise<void>) | null): void {
    afterReplaceReadHook = hook;
  },
  // Replaces the findClientProcess call in refreshEndpointForSessionStart with a
  // deterministic stub (findClientProcess scans real OS process ancestry and
  // ignores clientTaskId, so its outcome is otherwise environment-dependent). Pass
  // null to clear (falls through to the real findClientProcess).
  setProcessDetectionOverride(
    override: ((client: BusClient) => Promise<{ surface: BusSurface | null; process: ProcessCandidate | null }>) | null,
  ): void {
    processDetectionOverride = override;
  },
};
