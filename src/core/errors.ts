import type { ErrorCode } from "../models/types.js";

/**
 * Schema version written by fresh (non-team) `storybloq init`.
 * ISS-751: deliberately kept at 2 so a fresh non-team project remains readable
 * by every older client. Emission and acceptance are decoupled: do NOT bump
 * this when raising MAX_SUPPORTED_SCHEMA_VERSION.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Maximum Config.schemaVersion this loader accepts, for both reads and writes.
 * schemaVersion > this → version_mismatch (hard fail, exit 1).
 */
export const MAX_SUPPORTED_SCHEMA_VERSION = 4;

/**
 * T-537: stamped by `checkpoint enable`. Owner checkpoints are created,
 * attached and changed only in a project at this version or later, so no
 * client that ignores checkpoints (every CLI <= 1.15, which hard-fails on 4)
 * can write the ledger that holds one.
 */
export const CHECKPOINT_SCHEMA_VERSION = 4;

/**
 * Schema version stamped by team-init ONLY (the old-client fence, ISS-751).
 * Published clients <= 1.4.4 accept schemaVersion 2, so a v2 team repo gave
 * mixed-version teams silent partial reads. Those same clients hard-fail on
 * schemaVersion 3 for both reads and writes ("Config schemaVersion 3 exceeds
 * max supported 2", exit 1; verified empirically against published 1.4.4),
 * which turns the fence into the intended hard failure.
 *
 * Migration note (ISS-734 docs pending; keep this block until a team docs file
 * exists): existing team repos created before this fence carry schemaVersion 2.
 * Once ALL teammates run >= 1.5.0 CLIs, set schemaVersion to 3 manually (or
 * re-run `storybloq team init`). Older Mac app builds show a schemaVersion-3
 * project as read-only ("Please update Storybloq") until updated; no data loss.
 */
export const TEAM_SCHEMA_VERSION = 3;

export class ProjectLoaderError extends Error {
  readonly name = "ProjectLoaderError";

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type LoadWarningType =
  | "parse_error"
  | "schema_error"
  | "duplicate_id"
  | "naming_convention"
  | "filename_id_mismatch"
  | "filename_classification_mismatch"
  // ISS-730: advisory cross-reference integrity finding from the opt-in
  // validateOnLoad pass. Deliberately NOT an integrity type -- it must never
  // fail strict mode or hard-block a load, only surface in the warning stream.
  | "cross_reference";

/** Integrity warnings fail strict mode. Cosmetic warnings are collected but never block. */
export const INTEGRITY_WARNING_TYPES: readonly LoadWarningType[] = [
  "parse_error",
  "schema_error",
  "duplicate_id",
];

export interface LoadWarning {
  readonly file: string;
  readonly message: string;
  readonly type: LoadWarningType;
}
