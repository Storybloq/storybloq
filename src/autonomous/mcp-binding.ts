/**
 * Binding an MCP server process to a project's server registry (T-450).
 *
 * Extracted from the MCP entry point so it can be imported and tested without
 * executing `main()`. That is not tidiness: importing the entry point in a test
 * ran the server, marked the process registered, and broke unrelated tests
 * through global role state.
 *
 * WHY BINDING MATTERS. Only a REGISTERED server stamps its pid onto sessions,
 * and the registry is where a session's OWNER identity can be found alive
 * somewhere other than the dead server it recorded. A server missing from the
 * listing cannot be recognized as its owner's client, so a live restarted owner
 * can read as a recovery candidate.
 *
 * THE RESIDUAL WINDOW, stated rather than hidden. Registration can fail
 * transiently (ENOSPC, a race, a briefly read-only mount). Between the moment
 * the underlying cause clears and the moment a retry succeeds, this server is
 * live and unproven to OTHER processes. Two things bound that cross-process
 * window, and a third bounds a different failure this file used to have:
 *
 *  - registration is verified, not best-effort: the entry is read back after
 *    writing, so a silent failure is detected rather than assumed away
 *    (ruling C-2 item 4);
 *  - the first retry runs 100ms after the failure (see `RETRY_BACKOFF_MS`)
 *    rather than on a 30s tick, so a cause that has already cleared is picked
 *    up almost immediately. A cause that persists backs off to 250ms, 1s, 5s
 *    and then 30s, so the window widens only while the registry is genuinely
 *    still broken;
 *  - this process never reports its OWN entry as missing. `registerMcpServer`
 *    records an in-process vouch whether or not the write lands, so a listing
 *    that enumerates successfully still contains us while our file does not
 *    exist on disk (ruling C-2 item 3). The vouch is scoped to our own entry
 *    and nothing more: a registry that cannot be read or created at all stays
 *    `unavailable` for us and for every reader with the same access, because it
 *    may be hiding the owner's server and no vouch can speak to that.
 *
 * What remains FAILS OPEN, and saying so plainly is the point of writing it
 * down. A third process cannot see this server, so it cannot match this
 * server's identity against a session's owner. An ABSENT entry is not an
 * ambiguity signal: nothing in the predicate distinguishes "the owner's server
 * is missing from this listing" from "the owner's client is not running". So
 * for as long as our entry is missing while the registry itself reads fine, a
 * third evaluator holding one of our owner's stale sessions can reach
 * `gone-candidate` against a live owner.
 *
 * The two failures that reach other readers are covered: a registry that cannot
 * be read or created is `unavailable` for every reader with the same access,
 * which suppresses.
 * The gap is precisely the interval between the underlying cause clearing and
 * the retry landing, which is what the fast first retry is for. Closing it
 * entirely needs a durable cross-process handshake, a larger change than this
 * evidence path.
 */
import { registerMcpServer, unregisterMcpServer } from "./mcp-registry.js";
import { markMcpServerProcess, markMcpServerUnregistered } from "./liveness.js";
import { ownerTaskForCurrentClient, type OwnerTask } from "./client-profile.js";

/**
 * Fast first, slow after. The early attempts exist to collapse the transient
 * window; the trailing value is the steady-state poll for a cause that has not
 * cleared. The last entry repeats for every attempt beyond the list.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [100, 250, 1_000, 5_000, 30_000];

export interface BindDeps {
  readonly register: (root: string, identity: OwnerTask | null) => boolean;
  /**
   * Remove our entry, reporting whether it is actually gone. See
   * `releaseAllExcept`: a cleanup that failed must not be forgotten.
   */
  readonly unregister: (root: string) => boolean;
  /**
   * The identity to stamp on this process's registry entry, read from the spawn
   * environment. Injected so tests can bind a known identity without mutating
   * `process.env` (ruling C-2 item 1).
   */
  readonly identity: () => OwnerTask | null;
  readonly markRegistered: () => void;
  readonly markUnregistered: () => void;
  readonly schedule: (fn: () => void, ms: number) => { cancel: () => void };
  /**
   * Arrange for `release` to run when the process goes away. A seam rather than
   * a hardcoded `process.on`, because every binder instance would otherwise add
   * four permanent listeners to the real process, and a test that constructs
   * several would trip the max-listeners warning for reasons unrelated to what
   * it is testing.
   */
  readonly onExit: (release: () => void) => void;
  readonly log: (message: string) => void;
}

const defaultDeps: BindDeps = {
  register: registerMcpServer,
  unregister: unregisterMcpServer,
  // `CLAUDE_CODE_SESSION_ID` is present and stable across a same-task respawn.
  // Codex servers get only `STORYBLOQ_CLIENT` in their env, so they register
  // identity-null here and are upgraded at the guide-call seam, which is the
  // only path a Codex task id can arrive by.
  identity: () => ownerTaskForCurrentClient(),
  markRegistered: markMcpServerProcess,
  markUnregistered: markMcpServerUnregistered,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never hold the process open just to retry a registry write.
    (t as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(t) };
  },
  onExit: (release) => {
    process.on("exit", release);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => { release(); process.exit(0); });
    }
  },
  log: (message) => {
    try { process.stderr.write(message + "\n"); } catch { /* stderr may be closed */ }
  },
};

/** One binder per process. Exposed as a class so tests get isolated state. */
export class ServerRegistryBinder {
  private boundRoot: string | null = null;
  private attempt = 0;
  private pending: { cancel: () => void; root: string } | null = null;
  /**
   * Every root this process may have contributed an entry to.
   *
   * Not the same as "roots we bound". A registration that FAILS can still have
   * written the file and recorded a vouch: verification is a read-back, so the
   * write may well have landed and only the proof failed. Tracking the bound
   * root alone leaves those behind, and an entry carrying a live pid suppresses
   * or confuses evaluators that enumerate that project's registry, for as long
   * as the process lives.
   *
   * A root is added the moment we are about to write to it, and removed only
   * when its entry is CONFIRMED gone. A failed unlink keeps it tracked.
   */
  private touched = new Set<string>();
  /**
   * Cleanup has its OWN retry slot, separate from the registration one.
   *
   * Sharing would let the two starve each other, and they are not equally
   * urgent: repairing the root we actively serve keeps a live owner findable,
   * while cleaning an abandoned one removes a live pid from a project we have
   * walked away from. Both need to happen, neither may wait on the other.
   */
  private cleanupPending: { cancel: () => void } | null = null;
  private cleanupAttempt = 0;
  private exitHandlersInstalled = false;

  constructor(private readonly deps: BindDeps = defaultDeps) {}

  /** Currently bound root, or null when this process is not registered. */
  get root(): string | null { return this.boundRoot; }

  /** True while a REGISTRATION retry is scheduled. */
  get retrying(): boolean { return this.pending !== null; }

  /** True while an abandoned entry is still waiting to be cleaned up. */
  get cleaningUp(): boolean { return this.cleanupPending !== null; }

  /**
   * Bind to `root`. Idempotent, and safe to call twice: a server learns its
   * root at startup, and again when `storybloq_init` creates a project in a
   * server that began in degraded mode. Missing the second would leave that
   * server stamping pids while absent from the registry.
   */
  bind(root: string | null | undefined): void {
    if (!root || this.boundRoot === root) return;

    let ok = false;
    try {
      // Identity FIRST. If resolving it throws we have written nothing, so the
      // root must not be tracked as one we may have left an entry in.
      const identity = this.deps.identity();
      this.touched.add(root);
      ok = this.deps.register(root, identity);
    } catch { ok = false; }

    if (!ok) {
      // Live, serving, and unproven in the registry. When the registry was
      // actually reached, `registerMcpServer` has already recorded this
      // process's in-process vouch, so an enumeration that SUCCEEDS still
      // contains us (ruling C-2 item 3 forbids self-suppression). It does not
      // and cannot rescue an enumeration that fails outright, which is the
      // usual reason a registration failed in the first place: that answer is
      // `unavailable` for every reader with the same access. The one path with
      // no vouch at all
      // is an `identity()` that threw, which fails before any registry call.
      //
      // Declining the registered ROLE is a different thing: it makes
      // `refreshLease` CLEAR a predecessor's pid pair rather than leave behind
      // evidence this process could not verify.
      this.deps.markUnregistered();
      this.scheduleRetry(root);
      this.deps.log(`storybloq: could not register MCP server in ${root}; retrying`);
      return;
    }

    this.cancelRetry();
    this.attempt = 0;
    this.deps.markRegistered();
    this.boundRoot = root;
    // Everywhere else we may have written, including roots we bound and lost and
    // roots whose registration failed after the write landed. `cancelRetry`
    // above already dropped any repair we were pending, so nothing but the new
    // root is protected here.
    this.releaseAllExcept(new Set([root]));
    this.installExitHandlers();
  }

  /**
   * Our entry could not be proven present and correct at a request seam.
   *
   * The guide-call re-assert verifies against the file, so it can discover that
   * an entry established at startup has since been deleted, or no longer says
   * what it should. Reporting it is what keeps the discovery from going
   * nowhere: without it the process stays marked registered, keeps stamping its
   * pid onto every session it serves, and its entry stays missing, wrong, or
   * unattributable to readers that can enumerate the registry. That is the
   * state ruling C-2 item 4 exists to prevent, arrived at from the other end.
   *
   * Demotion is identical to a failed bind, because it is the same situation.
   * Scoped to the CURRENT root: a failure against some other root says nothing
   * about the registration we hold.
   */
  registrationLost(root: string | null | undefined): void {
    if (!root || this.boundRoot !== root) return;
    this.boundRoot = null;
    // Left in `touched`, and deliberately NOT unregistered here. Loss covers an
    // entry that is damaged and one that has gone missing entirely. Deleting a
    // damaged one is never better and is sometimes worse: content that parses
    // to identity-null reads as unattributable and SUPPRESSES, which deletion
    // would trade for the fail-open window described at the top of this file,
    // while content carrying some other valid identity is no worse gone than
    // present. A missing entry is already in that window and deleting nothing
    // changes it. The retry overwrites whichever it is, and if we end up
    // serving somewhere else instead, `releaseAllExcept` cleans it up then.
    this.deps.markUnregistered();
    this.scheduleRetry(root);
    this.deps.log(`storybloq: MCP server registration for ${root} could not be verified; retrying`);
  }

  /**
   * Give up every entry this process may hold. Idempotent.
   *
   * Clears the bound root and the registered ROLE, and starts cleanup of every
   * file. Cleanup is not guaranteed to finish here: an unlink that fails leaves
   * the root tracked and retrying on its own timer. Clearing `boundRoot` is
   * required rather than cosmetic, because a binder that reports a registration
   * it has removed returns early from `bind` on that same root, so the entry
   * can never be restored while the process goes on stamping its pid onto the
   * sessions it serves.
   *
   * Left-behind files are self-healing in the ordinary case, because the first
   * evaluator to enumerate probes the pid, gets ESRCH and reaps it. Cleaning up
   * eagerly is still worth it: until that enumeration happens the file is one
   * pid recycle away from reading as a live server that never existed.
   */
  release(): void {
    this.cancelRetry();
    // Only demote a process that had something to give up. A binder that never
    // wrote anywhere belongs to a CLI-like process, and marking that
    // `mcp-unregistered` is not a no-op: it makes `refreshLease` CLEAR a
    // predecessor's recorded pid pair instead of preserving it.
    const heldSomething = this.boundRoot !== null || this.touched.size > 0;
    this.boundRoot = null;
    // A fresh lifecycle has earned no backoff. Leaving the counter escalated
    // would have the next failed bind schedule its first retry 30 seconds out,
    // which is the same bound-defeating inheritance the re-aim path avoids.
    this.attempt = 0;
    if (heldSomething) this.deps.markUnregistered();
    // Nothing is protected: the retry is cancelled and the binding is given up,
    // so every root we may have written to is due for cleanup.
    this.releaseAllExcept(new Set());
  }

  /**
   * Drop every tracked entry except the roots in `keep`.
   *
   * A root stays tracked until its entry is CONFIRMED gone. Deleting once and
   * assuming loses the case that matters: a transient EACCES or EIO leaves a
   * live-pid entry in a project we have walked away from, and forgetting the
   * root means nothing ever tries again. Retained roots are retried on their
   * own timer (see `syncCleanupRetry`), and again on any later bind, release, or
   * re-aim of the registration retry.
   *
   * `keep` is a SET, not a single root, because more than one root can be off
   * limits at once. See `protectedRoots`.
   */
  private releaseAllExcept(keep: ReadonlySet<string>): void {
    for (const root of [...this.touched]) {
      if (keep.has(root)) continue;
      let gone = false;
      try { gone = this.deps.unregister(root); } catch { gone = false; }
      if (gone) this.touched.delete(root);
    }
    this.syncCleanupRetry(keep);
  }

  /**
   * Roots cleanup must not touch.
   *
   * The bound root is obvious. The REPAIR TARGET is not, and missing it undoes
   * the reasoning in `registrationLost`: that method deliberately leaves a
   * known-bad entry in place, because deleting it is never better and is worse
   * whenever the entry reads as unattributable, which suppresses. It also
   * clears `boundRoot`, so a cleanup timer firing in the interval before the
   * repair lands would see that root as abandoned and delete exactly the entry
   * we chose to keep, along with its vouch.
   */
  private protectedRoots(): ReadonlySet<string> {
    const keep = new Set<string>();
    if (this.boundRoot) keep.add(this.boundRoot);
    if (this.pending) keep.add(this.pending.root);
    return keep;
  }

  /**
   * Arm a cleanup retry while anything is still abandoned, and disarm when
   * nothing is.
   *
   * Retrying only on the next bind or release is not enough. The ordinary shape
   * of this failure is a move from A to B where A's unlink fails transiently:
   * the binder then sits on B indefinitely, `bind(B)` returns early as a no-op,
   * and nothing revisits A until the process exits, which can be hours. A live
   * pid in A's registry for all of that time either suppresses recovery there
   * or drags every verdict there to `undetermined`.
   */
  private syncCleanupRetry(keep: ReadonlySet<string>): void {
    const stillAbandoned = [...this.touched].some((root) => !keep.has(root));
    if (!stillAbandoned) {
      this.cleanupAttempt = 0;
      if (this.cleanupPending) {
        this.cleanupPending.cancel();
        this.cleanupPending = null;
      }
      return;
    }
    if (this.cleanupPending) return;
    const step = Math.min(this.cleanupAttempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[step] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 30_000;
    this.cleanupAttempt += 1;
    const timer = this.deps.schedule(() => {
      this.cleanupPending = null;
      // What is protected NOW, not when this timer was armed: both the bound
      // root and the repair target can have changed in between.
      this.releaseAllExcept(this.protectedRoots());
    }, delay);
    this.cleanupPending = { cancel: timer.cancel };
  }

  private scheduleRetry(root: string): void {
    if (this.pending) {
      // Already waiting on this exact root: one timer, not a growing pile.
      if (this.pending.root === root) return;
      // Aimed somewhere else. The slot belongs to the NEWEST statement of
      // intent, or a stale timer starves the root we actually need: bound to A,
      // a failed bind to B arms a B timer, and A then losing verification could
      // never schedule its own repair. Cancel, re-aim, and RESET the backoff.
      //
      // The reset is the load-bearing half. `attempt` is one counter, so a new
      // target would otherwise inherit however far the abandoned one had
      // escalated, and A's repair could be scheduled 30 seconds out. The fast
      // first retry is what bounds the fail-open window documented at the top of
      // this file; a fresh target has earned no backoff and must not serve it.
      this.cancelRetry();
      this.attempt = 0;
    }
    const step = Math.min(this.attempt, RETRY_BACKOFF_MS.length - 1);
    // The `??` is unreachable given the clamp above, but the index type admits
    // undefined and a silent NaN delay would disable retries entirely.
    const delay = RETRY_BACKOFF_MS[step] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 30_000;
    this.attempt += 1;
    const timer = this.deps.schedule(() => {
      this.pending = null;
      this.bind(root);
    }, delay);
    this.pending = { cancel: timer.cancel, root };
    // Aiming the slot can ABANDON a root: whatever it pointed at before just
    // left `protectedRoots`. Nothing else here would notice, and the other
    // synchronization points are a successful bind and a release, neither of
    // which is guaranteed to arrive while a repair keeps failing. Without this
    // call the abandoned root sits in `touched` with a live-pid entry in a
    // project we do not serve, suppressing recovery there for the life of the
    // process. Clean it now, and let it arm its own timer if the delete fails.
    this.releaseAllExcept(this.protectedRoots());
  }

  private cancelRetry(): void {
    if (!this.pending) return;
    this.pending.cancel();
    this.pending = null;
  }

  private installExitHandlers(): void {
    if (this.exitHandlersInstalled) return;
    this.exitHandlersInstalled = true;
    this.deps.onExit(() => { this.release(); });
  }
}

/** The process-wide binder used by the MCP entry point. */
export const serverRegistryBinder = new ServerRegistryBinder();
