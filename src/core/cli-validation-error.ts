import type { ErrorCode } from "../models/types.js";

/**
 * Additive discriminator for refusals a private adapter must tell apart.
 * The public code and message stay the same for CLI and MCP callers.
 */
export type CliValidationReason = "note_destructive_replace";

/** One constructor shared by CLI callers and private application adapters. */
export class CliValidationError extends Error {
  public readonly reason?: CliValidationReason;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { reason?: CliValidationReason },
  ) {
    super(message);
    this.name = "CliValidationError";
    if (options?.reason !== undefined) this.reason = options.reason;
  }
}
