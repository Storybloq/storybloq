/**
 * Shared directory-age classification for `.story/sessions/` entries (ISS-945).
 *
 * Used by BOTH the scanner (to classify a bare `state.json`-less directory as
 * `state-missing` vs the aged `state-missing-aged`) and the CLI (to decide
 * whether `corruptRemedy`'s `missing-state` branch may name `session delete`).
 * One helper so the two cannot drift on what "aged" means.
 *
 * `lstatSync` only, never `statSync`: a symlink's OWN metadata is what this
 * directory actually contains, and following it would report a DIFFERENT
 * entry's age, or escape the directory entirely. A symlink anywhere in the
 * subtree is therefore an ambiguity, not a data point, and forces `unknown`.
 *
 * Iterative (an explicit stack), not recursive: a deep or huge tree must not
 * overflow the call stack, and must be boundable by an entry/depth cap rather
 * than by how deep the runtime happens to let a call stack go.
 *
 * `unknown` always stays classified as NOT aged -- ambiguity is never resolved
 * toward treating a directory as safe to point a removal command at.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionDirAgeCaps {
  /** Total descendant entries visited before giving up. */
  readonly maxEntries: number;
  /** Directory nesting depth (the directory itself is depth 0) before giving up. */
  readonly maxDepth: number;
}

export const DEFAULT_SESSION_DIR_AGE_CAPS: SessionDirAgeCaps = {
  maxEntries: 5000,
  maxDepth: 32,
};

export type SessionDirAgeResult =
  | { readonly kind: "known"; readonly ageMs: number }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The fixed grace window past which a `state.json`-less session directory is
 * classified `aged-anomaly` instead of `state-missing` (ISS-945).
 *
 * This is a CLASSIFICATION POLICY, not a safety proof. `SIGSTOP` or any other
 * unbounded suspension of the writer that `mkdir`'d this directory is not
 * bounded by any finite window, so crossing it never proves no creator is
 * suspended and never proves the directory is debris. It is defensible
 * because every action taken on an `aged-anomaly` diagnostic's account is
 * human-invoked, and the two failure directions are asymmetric: treating a
 * live directory as too young costs nothing but another hour's wait, while
 * treating an aged one as safe to act on when it is not risks destroying live
 * state. Fixed, not configurable -- every reader of this classification (the
 * scanner, the guard, the CLI) must reach the same verdict for the same
 * directory.
 */
export const AGED_ANOMALY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The age of `dir`: `now` minus the newest `mtimeMs`/`ctimeMs` seen across the
 * directory itself and every descendant, walked non-recursively via `lstat`.
 *
 * Any of the following forces `unknown`, which callers must treat as
 * blocking/not-aged: the directory itself is unreadable; enumerating or
 * `lstat`-ing any descendant fails; a symlink is encountered anywhere in the
 * subtree; a timestamp is in the future relative to `now`; or the traversal
 * exceeds either cap in `caps`. Exceeding a cap is deliberately indistinguishable
 * from any other ambiguity -- a large tree gets the same safe answer as a
 * broken one.
 */
export function computeSessionDirAge(
  dir: string,
  now: number,
  caps: SessionDirAgeCaps = DEFAULT_SESSION_DIR_AGE_CAPS,
): SessionDirAgeResult {
  let newestMs = -Infinity;
  let entriesVisited = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const { path, depth } = next;

    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      return {
        kind: "unknown",
        reason: `Could not stat "${path}" while computing age (${(err as NodeJS.ErrnoException).code ?? "unknown error"}).`,
      };
    }

    if (st.isSymbolicLink()) {
      return {
        kind: "unknown",
        reason: `A symlink was encountered at "${path}" while computing age; its target's metadata belongs to a different entry, so age cannot be established.`,
      };
    }

    // Floored before comparison: `fs.Stats` timestamps carry sub-millisecond
    // precision on filesystems that support it, while `now` (whether
    // `Date.now()` or an injected value) is always a whole millisecond.
    // Comparing the raw fractional value against a whole-millisecond `now`
    // reads an entry touched in the SAME millisecond as `now` was captured as
    // "in the future" purely from rounding, not from any real clock skew.
    const mtimeMs = Math.floor(st.mtimeMs);
    const ctimeMs = Math.floor(st.ctimeMs);
    if (mtimeMs > now || ctimeMs > now) {
      return {
        kind: "unknown",
        reason: `"${path}" carries a timestamp in the future relative to now, so age cannot be established.`,
      };
    }
    newestMs = Math.max(newestMs, mtimeMs, ctimeMs);

    if (st.isDirectory()) {
      if (depth >= caps.maxDepth) {
        return {
          kind: "unknown",
          reason: `Directory depth exceeded ${caps.maxDepth} while computing age under "${dir}".`,
        };
      }
      let children: string[];
      try {
        children = readdirSync(path);
      } catch (err) {
        return {
          kind: "unknown",
          reason: `Could not list "${path}" while computing age (${(err as NodeJS.ErrnoException).code ?? "unknown error"}).`,
        };
      }
      for (const name of children) {
        entriesVisited++;
        if (entriesVisited > caps.maxEntries) {
          return {
            kind: "unknown",
            reason: `More than ${caps.maxEntries} entries were found while computing age under "${dir}".`,
          };
        }
        stack.push({ path: join(path, name), depth: depth + 1 });
      }
    }
  }

  return { kind: "known", ageMs: now - newestMs };
}

/**
 * Shared caveat, prepended to every `aged-anomaly` explanation regardless of
 * whether a command can be named for it (ISS-945 round-4/5 MAJOR 3).
 *
 * Deliberately conditional, never "correct and authorized": the window is a
 * classification policy (`AGED_ANOMALY_WINDOW_MS`'s doc), and age proves
 * neither debris nor the absence of a creator suspended by something like
 * `SIGSTOP`. Any surface that names a removal command for an aged directory
 * must carry this sentence alongside it, not just the command.
 */
export const AGED_ANOMALY_UNCERTAINTY =
  "That does not prove no session is being created here -- a creator suspended by something like SIGSTOP is not " +
  "bounded by this window -- so this is a policy classification, not a determination about this specific directory.";

/**
 * The full, caveated remedy text for an `aged-anomaly` directory whose name
 * IS a valid, addressable session id (ISS-945).
 *
 * Shared by the scanner's diagnostic `reason` and the CLI's `corruptRemedy` so
 * the two surfaces describe the same command in the same words. Takes
 * `sourceDir` directly rather than re-deriving addressability: by the time a
 * caller reaches for this text, `remedy: "session-delete"` (scanner) or the
 * CLI's own `SESSION_ID_REGEX` + containment check has already established
 * the name resolves.
 */
export function describeAddressableAgedAnomaly(sourceDir: string): string {
  return (
    "This session directory has no state.json, and nothing under it has changed during the one-hour classification " +
    `window. ${AGED_ANOMALY_UNCERTAINTY} Inspect the path directly. If you confirm it is abandoned, ` +
    `\`storybloq session delete ${sourceDir} --yes\` will remove it.`
  );
}

/**
 * The `aged-anomaly` explanation for a directory whose name is NOT a valid,
 * addressable session id -- a legacy or hand-created non-canonical name that
 * `resolveSessionSelector` can never resolve, so no `storybloq` command can be
 * named for it. Manual inspection only.
 */
export function describeUnaddressableAgedAnomaly(): string {
  return (
    "This session directory has no state.json, and nothing under it has changed during the one-hour classification " +
    `window, but its name is not a valid session id, so no storybloq command can address it directly. ${AGED_ANOMALY_UNCERTAINTY} ` +
    "Inspect the path directly."
  );
}
