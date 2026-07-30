/**
 * Binding an MCP server process to a project's server registry (T-450).
 *
 * Extracted from the MCP entry point so it can be imported and tested without
 * executing `main()`. That is not tidiness: importing the entry point in a test
 * ran the server, marked the process registered, and broke unrelated tests
 * through global role state.
 *
 * WHY BINDING MATTERS. Only a REGISTERED server stamps its pid onto sessions.
 * A server that stamps while absent from the listing is invisible to every
 * other evaluator, so a session it serves can present a dead predecessor pid,
 * no successor, and a death marker, which is exactly the evidence another
 * process would use to authorize taking over a live owner.
 *
 * THE RESIDUAL WINDOW, stated rather than hidden. Registration can fail
 * transiently (ENOSPC, a race, a briefly read-only mount). Between the moment
 * the underlying cause clears and the moment a retry succeeds, this server is
 * live and unlisted, and a third process evaluating a predecessor's session
 * cannot see it. Two things bound that window rather than close it by fiat:
 *
 *  - the first retry runs 100ms after the failure (see `RETRY_BACKOFF_MS`)
 *    rather than on a 30s tick, so a cause that has already cleared is picked
 *    up almost immediately. A cause that persists backs off to 250ms, 1s, 5s
 *    and then 30s, so the window widens only while the registry is genuinely
 *    still broken, which is the case the reader-side probe already covers;
 *  - the permanent case does not depend on retries at all, because a registry
 *    directory nobody can write to reads as `unavailable` for EVERY evaluator
 *    via the reader-side probe in `liveMcpServers`.
 *
 * What remains is a sub-second window requiring a transient failure that clears
 * immediately, a predecessor that died, and a third server older than the
 * predecessor's last guide call. It is bounded and documented; closing it
 * entirely needs a durable cross-process handshake, which is a larger change
 * than this evidence path.
 */
import {
  registerMcpServer,
  unregisterMcpServer,
  markRegistryUnavailable,
} from "./mcp-registry.js";
import { markMcpServerProcess, markMcpServerUnregistered } from "./liveness.js";

/**
 * Fast first, slow after. The early attempts exist to collapse the transient
 * window; the trailing value is the steady-state poll for a cause that has not
 * cleared. The last entry repeats for every attempt beyond the list.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [100, 250, 1_000, 5_000, 30_000];

export interface BindDeps {
  readonly register: (root: string) => boolean;
  readonly unregister: (root: string) => void;
  readonly markUnavailable: (root: string) => void;
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
  markUnavailable: markRegistryUnavailable,
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
  private pending: { cancel: () => void } | null = null;
  private exitHandlersInstalled = false;

  constructor(private readonly deps: BindDeps = defaultDeps) {}

  /** Currently bound root, or null when this process is not registered. */
  get root(): string | null { return this.boundRoot; }

  /** True while a retry is scheduled. */
  get retrying(): boolean { return this.pending !== null; }

  /**
   * Bind to `root`. Idempotent, and safe to call twice: a server learns its
   * root at startup, and again when `storybloq_init` creates a project in a
   * server that began in degraded mode. Missing the second would leave that
   * server stamping pids while absent from the registry.
   */
  bind(root: string | null | undefined): void {
    if (!root || this.boundRoot === root) return;

    let ok = false;
    try { ok = this.deps.register(root); } catch { ok = false; }

    if (!ok) {
      // Live, serving, and invisible. Both marks matter: the first makes this
      // process's own reads report `unavailable`, the second makes
      // `refreshLease` CLEAR a predecessor's pid pair rather than leave it
      // behind as actionable evidence.
      this.deps.markUnavailable(root);
      this.deps.markUnregistered();
      this.scheduleRetry(root);
      this.deps.log(`storybloq: could not register MCP server in ${root}; retrying`);
      return;
    }

    this.cancelRetry();
    this.attempt = 0;
    this.deps.markRegistered();
    const previous = this.boundRoot;
    this.boundRoot = root;
    if (previous && previous !== root) {
      try { this.deps.unregister(previous); } catch { /* best effort */ }
    }
    this.installExitHandlers();
  }

  /** Release this process's entry. Idempotent. */
  release(): void {
    this.cancelRetry();
    if (!this.boundRoot) return;
    try { this.deps.unregister(this.boundRoot); } catch { /* best effort */ }
  }

  private scheduleRetry(root: string): void {
    if (this.pending) return;
    const step = Math.min(this.attempt, RETRY_BACKOFF_MS.length - 1);
    // The `??` is unreachable given the clamp above, but the index type admits
    // undefined and a silent NaN delay would disable retries entirely.
    const delay = RETRY_BACKOFF_MS[step] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 30_000;
    this.attempt += 1;
    this.pending = this.deps.schedule(() => {
      this.pending = null;
      this.bind(root);
    }, delay);
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
