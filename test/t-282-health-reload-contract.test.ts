import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * T-282: Narrow FileWatcher reload scope + lightweight health refresh path.
 *
 * Source-contract tests that assert the key Swift APIs and invariants added by
 * T-282 are present. These are crude substring checks on the Swift source —
 * they fail before implementation and pass after.
 *
 * This sidesteps the fact that the Swift test target isn't driven by `npm test`;
 * the Swift-side assertions in claudestoryTests/*HealthReload*.swift still own
 * the runtime contract. This file just gives the autonomous guide a npm-visible
 * red-phase signal.
 */
describe("T-282 health reload contract", () => {
  const repoRoot = resolve(__dirname, "../..");
  const fileWatcherPath = resolve(repoRoot, "macos/claudestory/Core/FileWatcher.swift");
  const vmPath = resolve(repoRoot, "macos/claudestory/ViewModels/ProjectViewModel.swift");
  const telemetryPath = resolve(
    repoRoot,
    "macos/claudestory/ViewModels/ProjectViewModel+Telemetry.swift",
  );

  const fileWatcher = () => readFileSync(fileWatcherPath, "utf8");
  const vm = () => readFileSync(vmPath, "utf8");
  const telemetry = () => readFileSync(telemetryPath, "utf8");

  // --- FSEventCategory classifier ---

  it("FileWatcher exposes FSEventCategory enum", () => {
    expect(fileWatcher()).toMatch(/enum\s+FSEventCategory/);
  });

  it("FSEventCategory declares state, status, health, ignored cases", () => {
    const src = fileWatcher();
    expect(src).toMatch(/case\s+state/);
    expect(src).toMatch(/case\s+status/);
    expect(src).toMatch(/case\s+health/);
    expect(src).toMatch(/case\s+ignored/);
  });

  it("FileWatcher defines static classify(path:) returning FSEventCategory", () => {
    expect(fileWatcher()).toMatch(/static\s+func\s+classify\s*\(\s*path:/);
  });

  it("FileWatcher defines extractSessionId(from:)", () => {
    expect(fileWatcher()).toMatch(/extractSessionId\s*\(\s*from:/);
  });

  // --- New callbacks / pathFilter ---

  it("FileWatcher declares onHealthChange callback with sessionId argument", () => {
    // The plan specifies the argument is sessionId, not path.
    expect(fileWatcher()).toMatch(
      /onHealthChange:\s*\(\s*\(\s*(?:_\s+\w+:\s+)?String\s*\)\s*->\s*Void\s*\)\?/,
    );
  });

  it("FileWatcher declares pathFilter callback", () => {
    expect(fileWatcher()).toMatch(/pathFilter:\s*\(\s*\(\s*String\s*\)\s*->\s*Bool\s*\)\?/);
  });

  // --- Per-burst coalescing (R2-M5) ---

  it("fsEventCallback coalesces health events via a Set of session ids", () => {
    const src = fileWatcher();
    expect(src).toMatch(/Set<String>/);
    // The variable name used in the plan is healthSessionIds, but keep the check generic.
    expect(src).toMatch(/healthSessionIds|healthIds|\.health/);
  });

  // --- ProjectViewModel async reloadHealthOnly ---

  it("ProjectViewModel defines async reloadHealthOnly(sessionId:)", () => {
    expect(vm()).toMatch(/func\s+reloadHealthOnly\s*\(\s*sessionId:\s*String\s*\)\s+async/);
  });

  it("ProjectViewModel declares pendingHealthDelta state", () => {
    expect(vm()).toMatch(/pendingHealthDelta/);
  });

  it("ProjectViewModel declares lastAppliedHealth for stale-read guard", () => {
    expect(vm()).toMatch(/lastAppliedHealth/);
  });

  it("ProjectViewModel declares reloadInFlight lifecycle flag", () => {
    expect(vm()).toMatch(/reloadInFlight/);
  });

  it("ProjectViewModel declares HealthDelta struct with sessionId field", () => {
    const src = vm();
    expect(src).toMatch(/struct\s+HealthDelta/);
    expect(src).toMatch(/HealthDelta[^}]*sessionId/s);
  });

  // --- R2-M6: Forbid Thread.sleep / usleep / DispatchQueue.main.sync in reloadHealthOnly ---

  it("reloadHealthOnly uses Task.sleep, not Thread.sleep/usleep", () => {
    const src = vm();
    const start = src.indexOf("func reloadHealthOnly");
    expect(start).toBeGreaterThan(-1);
    // Crude bounded slice: stop at the next `    func ` at the same indentation.
    const tailCandidate = src.slice(start + 1);
    const nextFunc = tailCandidate.search(/\n {4}func\s+/);
    const body = nextFunc === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFunc);
    expect(body).toContain("Task.sleep(for:");
    expect(body).not.toContain("Thread.sleep");
    expect(body).not.toContain("usleep");
    expect(body).not.toContain("DispatchQueue.main.sync");
  });

  // --- Step 5a: shared broadcastStatus helper ---

  it("ProjectViewModel factors a broadcastStatus helper for the status payload", () => {
    expect(vm()).toMatch(/func\s+broadcastStatus\s*\(/);
  });

  // --- Step 6: per-session telemetry watcher uses pathFilter ---

  it("per-session telemetry watcher filters /telemetry/alive and /telemetry/lastMcpCall", () => {
    const src = telemetry();
    expect(src).toMatch(/pathFilter/);
    expect(src).toMatch(/hasSuffix\("\/telemetry\/alive"\)/);
    expect(src).toMatch(/hasSuffix\("\/telemetry\/lastMcpCall"\)/);
  });

  // --- Step 7: array caps at 500 ---

  it("telemetry arrays are capped at 500 entries", () => {
    const src = telemetry();
    expect(src).toMatch(/suffix\(\s*500\s*\)/);
  });

  // --- ISS-553: parseHealthFiles contract matches liveness.ts sidecar ---

  it("parseHealthFiles reads alive as epoch-ms integer (not 'true'/'false')", () => {
    const src = vm();
    const start = src.indexOf("private func parseHealthFiles");
    expect(start).toBeGreaterThan(-1);
    const tail = src.slice(start + 1);
    const nextFunc = tail.search(/\n {4}(?:private\s+)?func\s+/);
    const body = nextFunc === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFunc);
    // Parses the timestamp as a 64-bit integer.
    expect(body).toMatch(/Int64\s*\(\s*aliveTrimmed\s*\)/);
    // No longer matches on "true"/"false" literals.
    expect(body).not.toMatch(/case\s+"true"/);
    expect(body).not.toMatch(/case\s+"false"/);
  });

  it("parseHealthFiles honors the telemetry/shutdown marker", () => {
    const src = vm();
    const start = src.indexOf("private func parseHealthFiles");
    const tail = src.slice(start + 1);
    const nextFunc = tail.search(/\n {4}(?:private\s+)?func\s+/);
    const body = nextFunc === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFunc);
    expect(body).toMatch(/shutdown/);
    expect(body).toMatch(/fileExists/);
  });
});
