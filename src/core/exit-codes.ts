/** Canonical CLI exit codes, without the output formatter's implementation graph. */
export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  VALIDATION_ERROR: 2,
  PARTIAL: 3,
  // T-427 rendezvous long-poll: timeout and contended-waiter outcomes.
  // Signals SIGINT=130 and SIGTERM=143 remain outside this enum.
  TIMEOUT: 4,
  WAITER_ACTIVE: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
