import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { captureProcessSignatureSync, inspectProcessIdentitySync } from "../../src/core/process-identity.js";

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return r.pid!;
}

// captureProcessSignatureSync returns a signature only on Darwin/Linux; elsewhere
// it is null and identity is "unknown" (lease-governed). Baseline assertions must
// branch on this so the suite passes on every platform.
const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";

describe("process-identity", () => {
  it("process signature is stable for a live process and null for a dead one", () => {
    // A dead pid has no signature on ANY platform.
    expect(captureProcessSignatureSync(deadPid())).toBeNull();
    if (!SIG_SUPPORTED) {
      // No signature source here -- a live pid also yields null (see the
      // dedicated unsupported-platform test for identity semantics).
      expect(captureProcessSignatureSync(process.pid)).toBeNull();
      return;
    }
    const a = captureProcessSignatureSync(process.pid);
    const b = captureProcessSignatureSync(process.pid);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("inspectProcessIdentitySync classifies alive/dead/unknown", () => {
    // A dead pid classifies "dead" regardless of platform, and a null expected
    // signature is always "unknown".
    const sig = captureProcessSignatureSync(process.pid);
    expect(inspectProcessIdentitySync(deadPid(), sig)).toBe("dead");
    expect(inspectProcessIdentitySync(process.pid, null)).toBe("unknown");
    if (!SIG_SUPPORTED) {
      // No signature source: a live pid stays "unknown", never misclassified
      // (fully asserted in the unsupported-platform test below).
      expect(inspectProcessIdentitySync(process.pid, "darwin:bogus")).toBe("unknown");
      return;
    }
    expect(inspectProcessIdentitySync(process.pid, sig)).toBe("alive");
    expect(inspectProcessIdentitySync(process.pid, "darwin:bogus")).toBe("dead");
  });

  it("captureProcessSignatureSync yields null on an unsupported platform; a live holder stays unknown, never dead", () => {
    // On a platform with no signature source (not darwin/linux), identity is
    // UNKNOWN -- classifying a live pid as dead would let a successor steal a
    // fresh, legitimately-held lock. The lease is the only guard there.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    try {
      expect(captureProcessSignatureSync(process.pid)).toBeNull();
      expect(inspectProcessIdentitySync(process.pid, null)).toBe("unknown");
      expect(inspectProcessIdentitySync(process.pid, "darwin:whatever")).toBe("unknown");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
