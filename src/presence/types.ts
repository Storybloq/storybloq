/**
 * ISS-1022: session presence records.
 *
 * A live Claude Code session in a project used to show nothing in the Mac app:
 * `storybloq hook-status` asks for an AUTONOMOUS session record and, finding
 * none, writes `sessionActive: false`. Presence is the missing channel, and it
 * is deliberately NOT carried in `status.json`:
 *
 *   - `buildInactivePayload` is pinned by an exact-shape assertion, so adding a
 *     field there is a schema break;
 *   - per-turn updates would defeat the ISS-1012 content gate that stopped
 *     status.json churn;
 *   - a `StatusPayload` decode failure is retained-stale rather than surfaced
 *     on three of four read paths, so a new required field would present as a
 *     permanently frozen session UI on older readers.
 *
 * Records live at `.story/telemetry/presence/<sessionId>.json`, one file per
 * session, written only by that session's own hooks. The `/telemetry/` prefix
 * is load-bearing: `rootWatcherPathFilter` in the Mac app has dropped every
 * `/telemetry/` path except `alive` and `lastMcpCall` since T-282, which
 * predates both shipped releases, so presence writes are invisible to app
 * versions that know nothing about them. A sibling location such as
 * `.story/presence/` would fall through `FileWatcher.classify` to `.state` and
 * trigger a full project reload on every tool call on someone else's machine.
 */

/** Presence record schema version. Additive changes keep this number. */
export const PRESENCE_SCHEMA_VERSION = 1;

/**
 * Session ids come from the hook payload and are the key a record is stored
 * under. The leading-alnum requirement is what refuses `.`, `..` and hidden
 * names; the character class refuses every path separator on both platforms.
 * The remaining portability hazards it still admits (`:`, Windows device
 * names) are handled by `presenceFileBase`, not by narrowing this pattern --
 * this is the client's id shape, and it is not ours to reject.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Windows device basenames. `CON.json` IS the console device on Windows, so a
 * session whose id is `con` would make every presence write fail there.
 */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Longest id kept VERBATIM; anything longer goes to the encoded namespace. */
export const MAX_VERBATIM_BASENAME_BYTES = 200;

/**
 * Proven ceiling on ANY basename this writer emits, and the number that matters:
 * base32 of the longest legal id (128 bytes) is 205 characters, plus the `_`
 * prefix. Well under the 255-byte component limit APFS, ext4 and NTFS all
 * impose, with room for the `.json` and `.lock` extensions.
 */
export const MAX_PRESENCE_BASENAME_BYTES = 206;

/**
 * The on-disk basename for a session, WITHOUT extension.
 *
 * The session id is accepted as the client reports it (the same shape as
 * `CLIENT_TASK_ID_PATTERN`), but it is not always written to disk verbatim.
 * That shape permits `:`, which on NTFS is alternate-data-stream syntax; it
 * permits Windows device names; at its full 128 characters it can approach the
 * 255-byte component limit; and it permits uppercase, which on a
 * case-INSENSITIVE filesystem is the sharpest hazard of the four. APFS and NTFS
 * both fold case by default, so `abc` and `ABC` would address the SAME record
 * and two live sessions would overwrite each other. Encoding rather than
 * refusing, because refusing would silently drop presence for a session whose
 * id is perfectly legal.
 *
 * Two namespaces, injective across both AND stable under case folding. An id
 * that is already a lowercase portable basename is used as-is, which keeps the
 * common case (a lowercase UUID) readable in a directory listing. Everything
 * else becomes lowercase base32 of the raw id behind a `_` prefix: base32
 * rather than base64url precisely because base64url is case-sensitive and would
 * reintroduce the collision it was meant to fix. `_` is outside the accepted id
 * charset, so no literal id can land in the encoded namespace, and base32 of a
 * 128-byte id is 205 characters, so the encoded form is bounded by
 * construction.
 */
export function presenceFileBase(sessionId: string): string {
  if (isPortableBasename(sessionId)) return sessionId;
  return `_${base32Lower(Buffer.from(sessionId, "utf-8"))}`;
}

function isPortableBasename(id: string): boolean {
  // Lowercase only. An uppercase id folds onto its lowercase twin on APFS/NTFS,
  // and this is also what excludes `:` without a separate check.
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  if (WINDOWS_RESERVED_BASENAME.test(id)) return false;
  return Buffer.byteLength(id, "utf-8") <= MAX_VERBATIM_BASENAME_BYTES;
}

/** RFC 4648 base32, lowercase, unpadded. Hand-rolled to keep the hot entry's import graph at zero packages. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Buffer): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Byte caps. A long turn must not be able to grow a record past its own bounded reader. */
export const MAX_ID_BYTES = 128;
export const MAX_TOOL_NAME_BYTES = 64;
export const MAX_TARGET_BYTES = 200;
export const MAX_OPEN_TOOLS = 8;
export const MAX_CLOSED_TOOL_IDS = 32;
export const MAX_AGENT_IDS = 16;
/** Hard ceiling on the serialized record, enforced before write and by the reader. */
export const MAX_RECORD_BYTES = 16 * 1024;

/** Records untouched for this long are swept on the next SessionStart/SessionEnd. */
export const PRESENCE_TTL_MS = 12 * 60 * 60 * 1000;

export interface PresenceOpenTool {
  /** `tool_use_id` when the client supplies one, else a synthetic per-record id. */
  readonly id: string;
  readonly tool: string;
  /**
   * Project-relative path for the allowlisted file-tool inputs, proven to be
   * inside the project root. Null for every other tool and for any value that
   * could not be proven contained.
   */
  readonly target: string | null;
  readonly startedAt: string;
  readonly agentId: string | null;
}

export interface SessionPresence {
  readonly schemaVersion: number;
  readonly sessionId: string;
  /** Bumped by SessionStart. Resets turn state; does not reset `startedAt`. */
  readonly generation: number;
  /** Preserved across resume/clear/compact for an existing id. */
  readonly startedAt: string;
  readonly lastEventAt: string;
  /** The SessionStart `source` that last opened this record, when known. */
  readonly source: string | null;
  readonly openTools: readonly PresenceOpenTool[];
  /**
   * The most recent closures, so a straggler PreToolUse cannot reopen a tool
   * PostToolUse already closed. The protection is BOUNDED to this window: an id
   * evicted by MAX_CLOSED_TOOL_IDS later closures can reopen. See record.ts for
   * why that residual is accepted rather than paid for.
   */
  readonly closedToolIds: readonly string[];
  readonly agentIds: readonly string[];
  /**
   * Correlated to an ACTIVE autonomous session, so the Sessions panel renders
   * the autonomous view instead of a duplicate interactive row. Reversible on
   * purpose: a user keeps typing in the same Claude session after `/story auto`
   * finishes, with no new SessionStart, and a tombstone would hide the rest of
   * that session's work permanently.
   */
  readonly suppressed: boolean;
  /** Tombstone written by SessionEnd. */
  readonly endedAt: string | null;
}

export type PresenceHookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export const PRESENCE_HOOK_EVENTS: readonly PresenceHookEvent[] = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

export function isPresenceHookEvent(value: unknown): value is PresenceHookEvent {
  return typeof value === "string" && (PRESENCE_HOOK_EVENTS as readonly string[]).includes(value);
}
