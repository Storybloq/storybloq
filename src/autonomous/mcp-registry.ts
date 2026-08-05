/**
 * Which MCP servers are alive for this project, and WHOSE they are (T-450, ruling C-2).
 *
 * WHY THIS EXISTS. A session records the pid of the MCP server that last served
 * it. When that server exits, its alive sidecar writes a death marker. But an
 * ordinary MCP restart produces exactly that state while the owner task lives
 * on, and the recorded pid is then definitively dead, so the recorded pid alone
 * cannot tell "the owner's whole client went away" from "the server bounced and
 * the owner has not made a guide call since".
 *
 * WHY IDENTITY AND NOT TIME (ruling C-2, superseding C's successor clause). The
 * first version answered that question temporally: a server that registered
 * after the recorded server's last guide call was treated as its continuation.
 * That is wrong in both directions, and the fatal direction is the primary use
 * case. EVERY fresh client registers after a dead server's last guide call,
 * including the recovery client that is evaluating the offer and registered
 * itself at its own startup. So the evaluator counted ITSELF as a superseding
 * successor, the verdict came back `contradicted`, and the offer could never
 * fire from anyone who arrived to recover. Only a server that had been running
 * BEFORE the owner's last guide call could ever have seen `gone-candidate`.
 * Anchoring on marker time instead fails the other way, because an in-place
 * restart registers the true successor before the orphaned sidecar writes its
 * marker on the next tick.
 *
 * The question was never "is some server newer". It is "is the OWNER's client
 * alive somewhere else right now", and that is an identity question. Entries
 * therefore carry the registering server's client identity, and on succession
 * grounds only an identity MATCH invalidates the marker. (The recorded server's
 * own pid being alive invalidates it too, on other grounds entirely.) An entry
 * that cannot be attributed
 * does not: it resolves to `undetermined`, which withholds the offer without
 * claiming the owner is alive. `registeredAt` survives for display and audit
 * and is never read by the liveness predicate; it does reach the evidence
 * fingerprint, which is a separate question about what the human was shown.
 *
 * TRUST: same posture as the rest of this machinery. Ordinary workspace files,
 * corruption-resistant rather than forgery-resistant, and every ambiguity
 * resolves toward NOT offering, with one deliberate exception: this process
 * never reports its OWN entry as missing or unattributable (see `selfVouch`).
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { CLIENT_TASK_ID_PATTERN, type OwnerTask } from "./client-profile.js";
import { STORY_GITIGNORE_ENTRIES } from "../core/init.js";

const SERVERS_DIRNAME = "servers";

/**
  * Entry format version. Readers must also accept the v1 shape, a bare ISO
  * timestamp with no identity, which parses to identity-null.
  */
const ENTRY_VERSION = 2;

export interface RegisteredServer {
  readonly pid: number;
  /**
   * Whose client this server belongs to, in normalized `{client, id}` ownerTask
   * shape. This is the load-bearing field: a live entry whose identity equals
   * the session's owner proves the owner's client is alive NOW, which is the
   * only thing that positively invalidates the marker on succession grounds.
   *
   * Null when the entry predates identity-bearing registration (a v1
   * bare-timestamp file) or when the environment supplied no usable id. Null is
   * NOT "not the owner": an unattributable server could be the owner's, so it
   * resolves to `undetermined` rather than to either verdict.
   */
  readonly identity: OwnerTask | null;
  /**
   * When this server registered. DISPLAY AND AUDIT ONLY (ruling C-2).
   *
   * Nothing in the liveness predicate may read it: succession is decided by
   * identity, and deciding it by time is what let a recovery client count
   * itself as its own successor. It is kept because an operator reading the
   * evidence wants to know how long a server has been up, and because the
   * evidence fingerprint may legitimately include it.
   *
   * Null when unreadable or unparseable, which is now a cosmetic loss rather
   * than a reason to suppress.
   */
  readonly registeredAt: string | null;
}

/**
 * Observed successors, or an explicit statement that we could not look.
 *
 * `unavailable` is NOT the same as an empty `servers`. Empty means "we
 * enumerated and nothing else is running", which permits a candidate.
 * `unavailable` means the registry could not be read, so nothing can be
 * confirmed or ruled out.
 */
export type SuccessorServers =
  | { readonly kind: "observed"; readonly servers: readonly RegisteredServer[] }
  | { readonly kind: "unavailable"; readonly reason: string };

function serversDir(root: string): string {
  return join(root, ".story", SERVERS_DIRNAME);
}

function entryPath(root: string, pid: number): string {
  return join(serversDir(root), String(pid));
}

/**
 * ISS-947: self-heal `.story/.gitignore` at registration time, for checkouts
 * that never re-run `init` after `STORY_GITIGNORE_ENTRIES` gains an entry.
 * Mirrors hook-status.ts's `ensureGitignore` (same tolerate-ENOENT read,
 * trim-line membership test, append-only write) but stays fully synchronous:
 * `registerMcpServer` and `ServerRegistryBinder.bind` must never become async.
 * Every error is swallowed here, never thrown -- a gitignore write failure
 * must degrade soft and never turn into a registration failure.
 */
function ensureStoryRuntimeGitignored(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const lines = existing.split("\n").map((l) => l.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  try {
    fs.writeFileSync(gitignorePath, content, "utf-8");
  } catch {
    // Best-effort -- never block registration.
  }
}

/**
 * What THIS process knows about its own entry, per root.
 *
 * Ruling C-2 item 3: the evaluator vouches in-process for its own entry, so an
 * enumeration that SUCCEEDS is never missing us and never reports us as
 * unattributable. That was self-suppression: a process declaring itself unable
 * to see the registry BECAUSE of its own write, and thereby refusing to offer a
 * recovery it is the one running. This map is the in-process truth that
 * replaces reading our own file back off disk.
 *
 * Scoped to our own entry, and to enumerations that happened. A registry that
 * cannot be read or created at all stays `unavailable` for this process and for
 * every reader with the same access: it may be hiding the owner's server, and
 * no vouch can speak to somebody else's entry.
 */
const selfEntries = new Map<string, RegisteredServer>();

/**
  * Forget this process's vouch for `root`.
  *
  * Exported for tests. Production code clears the vouch through
  * `unregisterMcpServer`, which drops it as part of removing the entry.
  */
export function clearSelfVouch(root: string): void {
  selfEntries.delete(root);
}

/** What this process would contribute to `root`'s listing, if anything. */
export function selfVouch(root: string): RegisteredServer | undefined {
  return selfEntries.get(root);
}

function serializeEntry(entry: RegisteredServer): string {
  return JSON.stringify({
    v: ENTRY_VERSION,
    identity: entry.identity,
    registeredAt: entry.registeredAt,
  });
}

/**
 * Parse an entry file. A v1 bare timestamp yields identity-null rather than
 * failing: mixed-version registries are expected during rollout, and the
 * ruling accepts that those entries resolve to `undetermined` for as long as
 * they exist, which is until their server unregisters or their pid is reaped as
 * stale. Anything unparseable also yields identity-null with no timestamp,
 * which is the same honest "we could not attribute this server".
 */
function parseEntry(pid: number, raw: string): RegisteredServer {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // An entry written by a FUTURE version may mean something else by these
      // field names. Reading it as v2 would attribute a server on a guess;
      // identity-null resolves it to `undetermined` instead, which is the
      // fail-closed direction and costs only until the entry ages out.
      const identity = parsed.v === ENTRY_VERSION ? normalizeIdentity(parsed.identity) : null;
      const at = typeof parsed.registeredAt === "string" && !Number.isNaN(new Date(parsed.registeredAt).getTime())
        ? parsed.registeredAt
        : null;
      return { pid, identity, registeredAt: at };
    } catch {
      return { pid, identity: null, registeredAt: null };
    }
  }
  // v1: a bare ISO timestamp, no identity.
  const legacy = !Number.isNaN(new Date(text).getTime()) && text.length > 0 ? text : null;
  return { pid, identity: null, registeredAt: legacy };
}

/**
 * Accept only a fully-formed identity. A half-written one is worse than none:
 * a partial match could suppress a real recovery, and a partial mismatch could
 * permit one, so it degrades to null and lands in the `undetermined` arm.
 */
function normalizeIdentity(value: unknown): OwnerTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const client = raw.client;
  const id = raw.id;
  if (client !== "claude" && client !== "codex") return null;
  // The SAME grammar the owner's id was normalized through. Accepting a
  // noncanonical id would be worse than rejecting it: it can never equal a
  // normalized owner id, so it could not suppress, but it WOULD count as a
  // readable "known stranger" and let the verdict skip the
  // `successor-identity-unknown` arm that an unattributable server belongs in.
  if (typeof id !== "string" || !CLIENT_TASK_ID_PATTERN.test(id)) return null;
  const boundAt = typeof raw.boundAt === "string" ? raw.boundAt : "";
  return { client, id, boundAt };
}

/**
 * Record this process as a live MCP server for `root`, and VERIFY it landed.
 *
 * Verified rather than best-effort (ruling C-2 item 4). A silent write failure
 * leaves a live server whose entry is missing or wrong for readers that can
 * enumerate the registry, and under the identity predicate that is exactly the
 * state in which a restarted owner's own client cannot be found and a live
 * owner reads as a candidate. Writing and
 * then reading back is cheap, and it is the only thing standing between an
 * unproven initial bind and a server that serves its whole life on an entry
 * that is missing, wrong, or unattributable. Later
 * damage is a separate problem with a separate answer: the guide-call seam
 * rereads and repairs (see `reassertMcpServerIdentity`).
 *
 * Returns false when the entry cannot be proven present and correct. The caller
 * (see `mcp-binding.ts`) declines the registered role and retries.
 *
 * `pid` defaults to ours and exists so a test can plant a foreign entry. The
 * in-process vouch is deliberately NOT recorded in that case; see below.
 */
export function registerMcpServer(
  root: string,
  identity: OwnerTask | null,
  pid: number = process.pid,
): boolean {
  // Normalize at the boundary, through the SAME gate a reader applies. Writing
  // an identity the reader would reject creates a registration that can never
  // verify: the read-back parses it to null, the comparison fails, the binder
  // declines the role and retries, and the retry writes the same rejected value
  // again. Every production caller is already normalized, so this is defence in
  // depth against a loop rather than a live defect, and null here is honest: an
  // identity we cannot express is one we cannot claim.
  const normalized = normalizeIdentity(identity);
  const entry: RegisteredServer = { pid, identity: normalized, registeredAt: new Date().toISOString() };
  const payload = serializeEntry(entry);
  // Vouch FIRST, before the write can fail. This process is a live server for
  // `root` from this moment whether or not the write lands, and the whole point
  // of the vouch is that a failed write must not erase us from our own view.
  //
  // Only ever for OUR pid. `pid` is a parameter so tests can plant a foreign
  // entry, and vouching for one would have this process assert that some other
  // pid is live, which `liveMcpServers` would then re-add after reaping it.
  if (pid === process.pid) selfEntries.set(root, entry);
  try {
    const dir = serversDir(root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // ISS-947: `.story/` is guaranteed to exist from here on (the recursive
    // mkdir above creates it), which is what this self-heal needs -- calling
    // it any earlier would ENOENT-fail silently on a bare mkdtemp root.
    ensureStoryRuntimeGitignored(root);
    fs.writeFileSync(entryPath(root, pid), payload);
  } catch {
    return false;
  }
  // Read back and compare BYTES, not the parsed identity. Parsing first would
  // verify nothing in the most common case: a truncated, empty, or garbage
  // read-back parses to identity-null, which equals the identity a Codex server
  // registers with at startup, so a write to a full disk would report success
  // with nothing on disk. The file is pid-scoped, so we are its only writer and
  // exact equality is both safe and the strongest check available.
  try {
    if (fs.readFileSync(entryPath(root, pid), "utf-8") !== payload) return false;
  } catch {
    return false;
  }
  return true;
}

function sameIdentity(a: OwnerTask | null, b: OwnerTask | null): boolean {
  if (a === null || b === null) return a === b;
  return a.client === b.client && a.id === b.id;
}

/**
 * Re-assert this process's entry with a request-scoped identity.
 *
 * The guide-call seam is the ONLY path a Codex identity can arrive by:
 * `setup-skill` injects just `STORYBLOQ_CLIENT=codex` into the server env, so a
 * Codex server registers identity-null at startup and only learns its task id
 * when a call carrying `clientTaskId` arrives.
 *
 * It also REPAIRS what it can see, which is why the check reaches the
 * filesystem rather than stopping at the in-process vouch. An entry that is
 * gone, unreadable, or carrying the wrong identity is rewritten. Content that
 * still parses to the desired identity is left alone, so this is identity
 * repair, not envelope validation. The two outcomes differ: an entry that is
 * GONE leaves the owner's client unfindable, which is the state in which a live
 * owner reads as a recovery candidate, while one that is present but
 * unattributable resolves to `undetermined` and withholds the offer instead.
 * The first fails open and the second fails closed, and repairing covers both. Our own memory being right is no comfort
 * to the process that has to read the file, so the check costs one read per
 * guide call rather than a map lookup.
 *
 * A null `identity` never downgrades one already established: guide calls
 * arrive both with and without `clientTaskId`, and an entry that flapped
 * between attributable and unattributable would take the verdict with it.
 */
export function reassertMcpServerIdentity(
  root: string,
  identity: OwnerTask | null,
  pid: number = process.pid,
): boolean {
  const current = selfEntries.get(root);
  // Normalized before anything reads it, so an id the writer cannot express is
  // treated exactly like no id at all rather than triggering a rewrite on every
  // guide call that can never converge.
  const requested = normalizeIdentity(identity);
  const desired = requested ?? current?.identity ?? null;
  // Nothing to assert and nothing already asserted: this process was never
  // bound to `root`, and inventing a registration here would claim a role the
  // binder deliberately declined.
  if (requested === null && !current) return true;

  try {
    const onDisk = parseEntry(pid, fs.readFileSync(entryPath(root, pid), "utf-8"));
    if (sameIdentity(onDisk.identity, desired)) return true;
  } catch { /* absent, unreadable, or a directory: rewrite it below */ }
  return registerMcpServer(root, desired, pid);
}

/**
 * Remove a registry entry, ours by default, and REPORT whether it is gone.
 *
 * The boolean matters. An entry we failed to delete still carries a live pid,
 * and a live pid in a project this process no longer serves either suppresses
 * recovery there (if the entry is attributable to our task) or drags every
 * verdict there to `undetermined` (if it is not). The caller in
 * `mcp-binding.ts` keeps the root on its cleanup list until this returns true,
 * rather than deleting once and assuming.
 *
 * True means the entry is not there: unlinked now, or provably absent. ENOENT
 * says so directly; ENOTDIR says a component of the path is not a directory, so
 * no file can exist beneath it either. False means something else went wrong
 * (EACCES on the directory, EIO) and the file may well still exist.
 *
 * `pid` is a test affordance, the same as on `registerMcpServer`.
 */
export function unregisterMcpServer(root: string, pid: number = process.pid): boolean {
  // Symmetric with `registerMcpServer`: removing some other pid's file says
  // nothing about whether WE are still a live server for this root.
  if (pid === process.pid) selfEntries.delete(root);
  try {
    fs.unlinkSync(entryPath(root, pid));
    return true;
  } catch (e: any) {
    // Already gone, or somewhere a file cannot be: the postcondition, "the
    // entry is not there", holds either way.
    return !!e && (e.code === "ENOENT" || e.code === "ENOTDIR");
  }
}

/**
 * Enumerate live MCP servers for `root`, reaping stale entries as it goes.
 *
 * Every outcome that is not a complete enumeration is `unavailable`, with one
 * exception that ruling C-2 makes mandatory: once the directory HAS been
 * enumerated, this process never reports its own entry as missing or
 * unreadable. Wherever our own file would have been the reason to give up, the
 * in-process vouch is substituted instead.
 *
 * The exception is scoped to our own entry deliberately. See the comment on the
 * enumeration failures below for why a vouch cannot stand in for a directory
 * nobody could read.
 */
export function liveMcpServers(root: string): SuccessorServers {
  const self = selfEntries.get(root);
  const dir = serversDir(root);
  let entries: string[];
  // THE LIMIT OF THE VOUCH, and it is a real one.
  //
  // A vouch proves what THIS process contributes to the listing. It proves
  // nothing about whether anyone ELSE is missing from it, and the two failures
  // that land here are about the shared directory, not about our own entry: the
  // tree does not exist, or this reader cannot read it. Substituting the vouch would answer "enumerated, and the only
  // server running is me", which is a claim about every other process, made on
  // evidence about one. If the owner's own server failed to register for the
  // same reason ours did, that answer authorizes recovery against a live owner.
  //
  // This is NOT the self-suppression ruling C-2 item 3 forbids. That is a
  // process-local flag: declaring the registry unusable FOR OURSELVES because
  // of our own write, while any other reader sees it fine. Nothing here is
  // process-local: the failure is about shared state, not about a decision this
  // process made regarding itself. This is the current reader failing to read a
  // shared directory, and a vouch about our own entry cannot stand in for it. Another
  // process running as another uid may well read the directory fine; that is
  // its answer to give, not ours to assume.
  try {
    entries = fs.readdirSync(dir);
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      return { kind: "unavailable", reason: "registry directory does not exist" };
    }
    return { kind: "unavailable", reason: `registry unreadable (${e?.code ?? "error"})` };
  }

  // Writability, same reasoning: a directory this process cannot write to is a
  // standing explanation for why a live server might be missing from the
  // listing, so the listing cannot be treated as complete.
  try {
    const probe = join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (e: any) {
    return { kind: "unavailable", reason: `registry not writable (${e?.code ?? "error"})` };
  }

  const servers: RegisteredServer[] = [];
  let sawSelf = false;
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
      // our server, but it is not provably absent either, so keep it: under the
      // identity predicate an unattributable entry suppresses, which is safe.
      if (!e || e.code !== "EPERM") {
        return { kind: "unavailable", reason: `pid probe failed (${e?.code ?? "error"})` };
      }
    }
    if (self && pid === self.pid) {
      // Our own entry: trust memory over the filesystem. A corrupted or
      // half-written own file must not become `identity: null` and drag the
      // verdict to `undetermined`, which is the self-suppression item 3 names.
      servers.push(self);
      sawSelf = true;
      continue;
    }
    let entry: RegisteredServer;
    try {
      entry = parseEntry(pid, fs.readFileSync(join(dir, name), "utf-8"));
    } catch {
      // Unreadable and NOT ours. Unattributable, so it is carried as
      // identity-null and the predicate resolves it to `undetermined`.
      entry = { pid, identity: null, registeredAt: null };
    }
    servers.push(entry);
  }
  // Present but unlisted: our write failed or our file was removed underneath
  // us. The directory enumerated successfully, so substituting our known
  // contribution restores what WE are owed in it. That is all it claims: the
  // enumeration itself is still only what this reader could see. Unlike the
  // ENOENT case above, it makes no claim about a registry we could not read.
  if (self && !sawSelf) servers.push(self);
  return { kind: "observed", servers };
}
