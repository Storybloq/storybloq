/**
 * T-538 S3a-2 commit 3: the verification record in the config, written only
 * by a setup that establishes a test stage, and owned by the config digest
 * only where present.
 */
import { describe, it, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupApply, setupResume } from "../../src/core/setup-apply.js";
import { initialRecord, readRecord } from "../../src/core/setup-verification-record.js";
import { validateSetupPayload } from "../../src/core/setup-payload.js";
import type { Config } from "../../src/models/config.js";
import { SID, comp, faultOnce, payload, pinEnvironment, t } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3a2r");

const configOf = async (root: string) => JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as Record<string, unknown>;

describe("the verification record", () => {
  it("is written with the stages when the payload establishes a test stage", async () => {
    const root = await folder();
    expect((await setupApply(root, payload())).exitCode).toBe(0);
    const config = await configOf(root);
    expect(config.setupVerification).toEqual({
      version: 1, setupId: SID, level: "tests-only", verifyApplies: false,
      components: [{ id: "app", workdir: ".", test: { command: "npm test", status: "pending", reason: "no tests yet", runner: "vitest", wrapper: "npm" }, build: null, verify: null }],
    });
    expect(readRecord(config as unknown as Config).kind).toBe("ok");
    expect(config.setupVerification).toEqual(initialRecord(validateSetupPayload(payload())));
  });

  it("is not written by a setup that establishes nothing", async () => {
    const root = await folder();
    const plain = payload({ tickets: [t("K2", [])], components: [{ ...comp(), test: { command: "npm test", status: "pending", reason: "r" } }] });
    expect((await setupApply(root, plain)).exitCode).toBe(0);
    expect(Object.hasOwn(await configOf(root), "setupVerification")).toBe(false);
  });

  it("an outside edit to it during an unfinished setup is config drift", async () => {
    const root = await folder();
    faultOnce("step:config");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    const config = await configOf(root);
    (config.setupVerification as { level: string }).level = "full";
    await writeFile(join(root, ".story", "config.json"), JSON.stringify(config, null, 2) + "\n");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines.join("\n")).toContain("Ambiguity: config drifted · .story/config.json");
  });

  it("reads as absent, invalid or ok, strictly", () => {
    const rec = initialRecord(validateSetupPayload(payload()));
    expect(readRecord({} as Config).kind).toBe("absent");
    expect(readRecord({ setupVerification: rec } as unknown as Config).kind).toBe("ok");
    expect(readRecord({ setupVerification: { ...rec, version: 2 } } as unknown as Config).kind).toBe("invalid");
    expect(readRecord({ setupVerification: { ...rec, extra: 1 } } as unknown as Config).kind).toBe("invalid");
    const badStatus = { ...rec, components: [{ ...rec.components[0]!, test: { ...rec.components[0]!.test!, status: "passed" } }] };
    expect(readRecord({ setupVerification: badStatus } as unknown as Config).kind).toBe("invalid");
    const decided = { ...rec, components: [{ ...rec.components[0]!, decision: { kind: "leave-off", ownerWords: "later", at: "x" } }] };
    expect(readRecord({ setupVerification: decided } as unknown as Config).kind).toBe("ok");
  });
});
