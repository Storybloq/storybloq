import type { ErrorCode } from "../models/types.js";

/** One constructor shared by CLI callers and private application adapters. */
export class CliValidationError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliValidationError";
  }
}
