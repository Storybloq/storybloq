/**
 * T-538 S3b commit 1: a setup can establish a component's BUILD or VERIFY
 * stage as well as its test stage. The payload allows BUILD and VERIFY only
 * under the full level, VERIFY only where it applies and only at a readiness
 * URL setup-verify can own; and the ticket's verification spec is a union on
 * the stage.
 */
import { describe, it, expect } from "vitest";
import { readinessEndpoint, validateSetupPayload } from "../../src/core/setup-payload.js";
import { parseSetupMeta } from "../../src/core/setup-meta.js";
import { setupApply, VERIFICATION_TIMEOUT_MS, VERIFY_SHUTDOWN_TIMEOUT_MS, VERIFY_STARTUP_TIMEOUT_MS } from "../../src/core/setup-apply.js";
import { SID, comp, payload, pinEnvironment, t, ticketFile, type PT } from "./t538-s3a2-fixture.js";

const { folder } = pinEnvironment("t538-s3b-est");

const estStage = (key: string, scaffold: string, stage: string, component = "app"): PT => t(key, [scaffold], { establishes: { component, stage, scaffold } });

const BUILD_PENDING = { command: "npm run build", status: "pending", reason: "no build yet" };
const VERIFY_PENDING = (readinessUrl = "http://127.0.0.1:4310/health") => ({ startCommand: "npm start", readinessUrl, status: "pending", reason: "no server yet" });

/** A full-level payload whose one component has a pending BUILD and VERIFY, establishing `stage` with K3. */
function full(stage: "build" | "verify", over: { level?: string; verifyApplies?: boolean; component?: Record<string, unknown>; tickets?: PT[] } = {}): Record<string, unknown> {
  const p = payload({
    level: over.level ?? "full",
    components: [over.component ?? { ...comp(), build: BUILD_PENDING, verify: VERIFY_PENDING() }],
    tickets: over.tickets ?? [t("K2", []), estStage("K3", "K2", stage), t("K4", ["K3"])],
  });
  (p.quality as { verifyApplies: boolean }).verifyApplies = over.verifyApplies ?? true;
  return p;
}

const refusal = (p: Record<string, unknown>): string => {
  try {
    validateSetupPayload(p);
  } catch (err) {
    return (err as Error).message;
  }
  return "accepted";
};

describe("the BUILD and VERIFY establishment payload", () => {
  it("accepts a BUILD and a VERIFY establishment under the full level", () => {
    expect(refusal(full("build"))).toBe("accepted");
    expect(refusal(full("verify"))).toBe("accepted");
  });

  it("accepts the test, BUILD and VERIFY of one component established by three tickets", () => {
    const tickets = [t("K2", []), estStage("K3", "K2", "test"), estStage("K5", "K2", "build"), estStage("K6", "K2", "verify"), t("K4", ["K3", "K5", "K6"])];
    expect(refusal(full("build", { tickets }))).toBe("accepted");
  });

  it("refuses BUILD and VERIFY below the full level, by name", () => {
    expect(refusal(full("build", { level: "tests-only" }))).toMatch(/K3 establishes app's build stage, which only the full level runs \(this setup is tests-only\)/);
    expect(refusal(full("verify", { level: "minimal" }))).toMatch(/K3 establishes app's verify stage, which only the full level runs \(this setup is minimal\)/);
  });

  it("refuses VERIFY where it does not apply", () => {
    expect(refusal(full("verify", { verifyApplies: false }))).toMatch(/K3 establishes app's verify stage, but VERIFY does not apply to this project/);
  });

  it("refuses a stage that is not pending, or absent", () => {
    const established = { ...comp(), build: { command: "npm run build", status: "established" }, verify: { ...VERIFY_PENDING(), status: "established" } };
    expect(refusal(full("build", { component: established }))).toMatch(/K3 establishes app's build stage, which is not pending/);
    expect(refusal(full("verify", { component: established }))).toMatch(/K3 establishes app's verify stage, which is not pending/);
    expect(refusal(full("build", { component: { ...comp(), build: null, verify: null } }))).toMatch(/app's build stage, which is not pending/);
    expect(refusal(full("verify", { component: { ...comp(), build: null, verify: null } }))).toMatch(/app's verify stage, which is not pending/);
  });

  it("refuses a readiness URL setup-verify cannot own", () => {
    for (const url of ["http://localhost:4310/health", "https://127.0.0.1:4310/", "http://127.0.0.1/health", "http://127.0.0.1:0/", "http://127.0.0.1:04310/", "http://127.0.0.1:65536/", "http://127.0.0.1:4310/a#b", "http://0.0.0.0:4310/"]) {
      const component = { ...comp(), build: BUILD_PENDING, verify: VERIFY_PENDING(url) };
      expect(refusal(full("verify", { component })), url).toMatch(/whose readiness URL .* is not http:\/\/127\.0\.0\.1:<port>\/<path>/);
    }
  });

  it("refuses two tickets establishing one component's same stage, and keys the check by stage", () => {
    const tickets = [t("K2", []), estStage("K3", "K2", "build"), estStage("K5", "K2", "build")];
    expect(refusal(full("build", { tickets }))).toMatch(/K3 and K5 both establish app's build stage/);
  });

  it("keeps the deadlock rules for BUILD and VERIFY", () => {
    const tickets = [t("K2", []), t("K7", []), t("K3", ["K2", "K7"], { establishes: { component: "app", stage: "build", scaffold: "K2" } })];
    expect(refusal(full("build", { tickets }))).toMatch(/K3 waits on K7; an establishment ticket waits on its scaffold K2 alone/);
    const scaffoldWaits = [t("K2", ["K3"]), estStage("K3", "K2", "verify")];
    expect(refusal(full("verify", { tickets: scaffoldWaits }))).toMatch(/K3's scaffold K2 waits on K3/);
  });

  it("reads a readiness endpoint, defaulting the path to /", () => {
    expect(readinessEndpoint("http://127.0.0.1:4310/health?x=1")).toEqual({ port: 4310, path: "/health?x=1" });
    expect(readinessEndpoint("http://127.0.0.1:1")).toEqual({ port: 1, path: "/" });
    expect(readinessEndpoint("http://127.0.0.1:65535/")).toEqual({ port: 65535, path: "/" });
  });
});

describe("the verification spec union", () => {
  const meta = (spec: Record<string, unknown>, establishes: Record<string, unknown> = { component: "app", stage: spec.stage, scaffold: "K2" }) =>
    parseSetupMeta("ticket", { setup: { setupId: SID, key: "K3", establishes, verification: { spec } } });
  const build = { setupId: SID, component: "app", stage: "build", workdir: ".", command: "npm run build", timeoutMs: 1000 };
  const verify = { setupId: SID, component: "app", stage: "verify", workdir: ".", command: "npm start", host: "127.0.0.1", port: 4310, readinessPath: "/health", startupTimeoutMs: 1000, shutdownTimeoutMs: 1000 };

  it("reads a BUILD and a VERIFY spec", () => {
    expect(meta(build).kind).toBe("item");
    expect(meta(verify).kind).toBe("item");
  });

  it("is strict per stage: a test field on a BUILD spec, another host, a relative path or a bad port do not read", () => {
    expect(meta({ ...build, runner: "vitest" }).kind).toBe("invalid");
    expect(meta({ ...verify, host: "localhost" }).kind).toBe("invalid");
    expect(meta({ ...verify, readinessPath: "health" }).kind).toBe("invalid");
    expect(meta({ ...verify, port: 0 }).kind).toBe("invalid");
    expect(meta({ ...verify, port: 65536 }).kind).toBe("invalid");
  });

  it("refuses a spec for another stage or component than the ticket establishes", () => {
    expect(meta(build, { component: "app", stage: "verify", scaffold: "K2" })).toEqual({ kind: "invalid", reason: expect.stringMatching(/its spec is for another/) });
    expect(meta(build, { component: "api", stage: "build", scaffold: "K2" })).toEqual({ kind: "invalid", reason: expect.stringMatching(/its spec is for another/) });
  });
});

describe("a setup that establishes BUILD or VERIFY", () => {
  it("creates the BUILD establishment with its spec", async () => {
    const root = await folder();
    expect((await setupApply(root, full("build"))).exitCode).toBe(0);
    const setup = (await ticketFile(root, "T-002")).setup as { establishes: unknown; verification: { spec: unknown } };
    expect(setup.establishes).toEqual({ component: "app", stage: "build", scaffold: "K2" });
    expect(setup.verification.spec).toEqual({ setupId: SID, component: "app", stage: "build", workdir: ".", command: "npm run build", timeoutMs: VERIFICATION_TIMEOUT_MS });
  });

  it("creates the VERIFY establishment with the endpoint from its readiness URL", async () => {
    const root = await folder();
    expect((await setupApply(root, full("verify"))).exitCode).toBe(0);
    const setup = (await ticketFile(root, "T-002")).setup as { verification: { spec: unknown } };
    expect(setup.verification.spec).toEqual({
      setupId: SID, component: "app", stage: "verify", workdir: ".", command: "npm start",
      host: "127.0.0.1", port: 4310, readinessPath: "/health",
      startupTimeoutMs: VERIFY_STARTUP_TIMEOUT_MS, shutdownTimeoutMs: VERIFY_SHUTDOWN_TIMEOUT_MS,
    });
  });
});
