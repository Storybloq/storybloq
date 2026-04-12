/**
 * T-257 telemetry accumulator tests.
 *
 * Tests for accumulateVerificationCounters which reads
 * verification-telemetry.jsonl and merges counters into session state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  accumulateVerificationCounters,
} from "../../../src/autonomous/review-lenses/verification-log.js";

// ── Fixtures ──────────────────────────────────────────────────────

interface MockState {
  verificationCounters?: {
    proposed: number;
    verified: number;
    rejected: number;
    filed: number;
    lastTelemetryLine: number;
  };
}

function makeCtx(sessionDir: string, state: MockState = {}) {
  let currentState = { ...state };
  return {
    sessionDir,
    get state() {
      return currentState;
    },
    writeState(updates: Partial<MockState>) {
      currentState = { ...currentState, ...updates };
      return currentState;
    },
  };
}

function writeTelemetryLine(
  sessionDir: string,
  entry: { proposed: number; verified: number; rejected: number; [k: string]: unknown },
) {
  const path = join(sessionDir, "verification-telemetry.jsonl");
  const line = JSON.stringify({
    reviewId: `review-${Date.now()}`,
    proposed: entry.proposed,
    verified: entry.verified,
    rejected: entry.rejected,
    timestamp: new Date().toISOString(),
    ...entry,
  });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  writeFileSync(path, existing + line + "\n");
}

// ── Tests ─────────────────────────────────────────────────────────

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "t257-accum-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("accumulateVerificationCounters", () => {
  it("malformed middle line skipped, valid lines still accumulated, checkpoint advanced", () => {
    const path = join(sessionDir, "verification-telemetry.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ reviewId: "r1", proposed: 5, verified: 3, rejected: 2, timestamp: "t1" }),
        "THIS IS NOT JSON",
        JSON.stringify({ reviewId: "r3", proposed: 10, verified: 8, rejected: 2, timestamp: "t3" }),
      ].join("\n") + "\n",
    );

    const ctx = makeCtx(sessionDir);
    accumulateVerificationCounters(ctx as any);

    const vc = ctx.state.verificationCounters!;
    // Should accumulate lines 0 and 2 (skipping malformed line 1)
    expect(vc.proposed).toBe(15); // 5 + 10
    expect(vc.verified).toBe(11); // 3 + 8
    expect(vc.rejected).toBe(4); // 2 + 2
    // Checkpoint should advance past all 3 lines
    expect(vc.lastTelemetryLine).toBe(3);
  });

  it("empty telemetry file: no parse error, no state write", () => {
    writeFileSync(join(sessionDir, "verification-telemetry.jsonl"), "");

    const ctx = makeCtx(sessionDir);
    accumulateVerificationCounters(ctx as any);

    // No verificationCounters should be written
    expect(ctx.state.verificationCounters).toBeUndefined();
  });

  it("accumulator idempotent: re-running without new lines produces no state change", () => {
    writeTelemetryLine(sessionDir, { proposed: 5, verified: 3, rejected: 2 });

    const ctx = makeCtx(sessionDir);

    // First accumulation
    accumulateVerificationCounters(ctx as any);
    const after1 = { ...ctx.state.verificationCounters! };

    // Second accumulation (no new lines)
    accumulateVerificationCounters(ctx as any);
    const after2 = ctx.state.verificationCounters!;

    expect(after2.proposed).toBe(after1.proposed);
    expect(after2.verified).toBe(after1.verified);
    expect(after2.rejected).toBe(after1.rejected);
    expect(after2.lastTelemetryLine).toBe(after1.lastTelemetryLine);
  });
});
