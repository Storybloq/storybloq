import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  discoverIntegrityRoot,
  scanLedgerIntegrity,
} from "../../src/core/ledger-integrity.js";
import { formatLedgerIntegrity } from "../../src/core/output-formatter.js";

const tempDirs: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "story-integrity-"));
  tempDirs.push(root);
  await initProject(root, { name: "integrity" });
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loader-independent ledger integrity", () => {
  it("reports every malformed canonical file with classifications and positions", async () => {
    const root = await project();
    await writeFile(join(root, ".story", "config.json"), "{\n  bad\n", "utf8");
    await writeFile(join(root, ".story", "roadmap.json"), "[", "utf8");
    await writeFile(join(root, ".story", "issues", "ISS-BAD.json"), "{ nope }", "utf8");

    const result = await scanLedgerIntegrity(root);

    expect(result.valid).toBe(false);
    expect(result.criticalErrorCount).toBe(2);
    expect(result.itemErrorCount).toBe(1);
    expect(result.findings.map((finding) => finding.file)).toEqual([
      ".story/config.json",
      ".story/issues/ISS-BAD.json",
      ".story/roadmap.json",
    ]);
    expect(result.findings[0]).toEqual(expect.objectContaining({
      code: "invalid_json",
      line: expect.any(Number),
      column: expect.any(Number),
    }));
    for (const finding of result.findings.filter((entry) => entry.code === "invalid_json")) {
      expect(finding.line).toEqual(expect.any(Number));
      expect(finding.column).toEqual(expect.any(Number));
    }
  });

  it("distinguishes known schema failures from JSON syntax failures", async () => {
    const root = await project();
    await writeFile(join(root, ".story", "issues", "ISS-BAD.json"), "{}\n", "utf8");

    const result = await scanLedgerIntegrity(root);

    expect(result.findings).toContainEqual(expect.objectContaining({
      file: ".story/issues/ISS-BAD.json",
      classification: "item",
      code: "schema_error",
    }));
  });

  it("reports missing critical files and discovers the root without config", async () => {
    const root = await project();
    await rm(join(root, ".story", "config.json"));

    expect(await discoverIntegrityRoot(join(root, ".story", "issues"))).toBe(root);
    const result = await scanLedgerIntegrity(root);
    expect(result.findings).toContainEqual(expect.objectContaining({
      file: ".story/config.json",
      classification: "critical",
      code: "missing_file",
    }));
  });

  it("scans auxiliary JSON only in explicit integrity-only mode", async () => {
    const root = await project();
    const sessionDir = join(root, ".story", "sessions", "fixture");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "state.json"), "not json", "utf8");

    const canonical = await scanLedgerIntegrity(root);
    const all = await scanLedgerIntegrity(root, { includeAuxiliary: true });

    expect(canonical.findings.some((finding) => finding.file.includes("sessions"))).toBe(false);
    expect(all.findings).toContainEqual(expect.objectContaining({
      file: ".story/sessions/fixture/state.json",
      classification: "auxiliary",
      code: "invalid_json",
    }));
  });

  it("does not follow symlinks and never modifies source files", async () => {
    const root = await project();
    const outside = join(root, "outside.json");
    await writeFile(outside, "not json", "utf8");
    await symlink(outside, join(root, ".story", "linked.json"));
    const before = await readFile(outside, "utf8");

    const result = await scanLedgerIntegrity(root, { includeAuxiliary: true });

    expect(result.skippedSymlinks).toBe(1);
    expect(result.findings.some((finding) => finding.file.endsWith("linked.json"))).toBe(false);
    expect(await readFile(outside, "utf8")).toBe(before);
  });

  it("formats deterministic markdown and JSON reports", async () => {
    const root = await project();
    const result = await scanLedgerIntegrity(root, { includeAuxiliary: true });

    expect(formatLedgerIntegrity(result, "md")).toContain("Ledger integrity passed");
    const json = JSON.parse(formatLedgerIntegrity(result, "json"));
    expect(json).toMatchObject({ version: 1, data: { valid: true } });
  });

  describe("T-476: rulings wired into the item-directory contract", () => {
    it("recognizes .story/rulings/*.json as a classified item, not auxiliary (ruling #5)", async () => {
      const root = await project();
      await mkdir(join(root, ".story", "rulings"), { recursive: true });
      await writeFile(join(root, ".story", "rulings", "r-bad.json"), "{}\n", "utf8");

      const result = await scanLedgerIntegrity(root);

      expect(result.findings).toContainEqual(expect.objectContaining({
        file: ".story/rulings/r-bad.json",
        classification: "item",
        code: "schema_error",
      }));
    });

    it("still classifies tickets/issues/notes/lessons correctly after the contractFor derivation (hard bar: zero behavior change)", async () => {
      const root = await project();
      await writeFile(join(root, ".story", "notes", "N-BAD.json"), "{}\n", "utf8");
      await writeFile(join(root, ".story", "lessons", "L-BAD.json"), "{}\n", "utf8");

      const result = await scanLedgerIntegrity(root);

      expect(result.findings).toContainEqual(expect.objectContaining({ file: ".story/notes/N-BAD.json", classification: "item", code: "schema_error" }));
      expect(result.findings).toContainEqual(expect.objectContaining({ file: ".story/lessons/L-BAD.json", classification: "item", code: "schema_error" }));
    });

    it("reports oversized rather than reading a file past the scan cap in full (ruling #6)", async () => {
      const root = await project();
      await mkdir(join(root, ".story", "rulings"), { recursive: true });
      const oversized = "x".repeat(1_048_576 + 1);
      await writeFile(join(root, ".story", "rulings", "r-huge.json"), oversized, "utf8");

      const result = await scanLedgerIntegrity(root);

      const finding = result.findings.find((f) => f.file === ".story/rulings/r-huge.json");
      expect(finding).toEqual(expect.objectContaining({ code: "oversized", classification: "item" }));
      // Never classified as invalid_json/schema_error -- proves the content was never parsed.
      expect(finding?.code).not.toBe("invalid_json");
      expect(finding?.code).not.toBe("schema_error");
    });

    it("does not read a multi-megabyte oversized file in full (not just a limit+1 fixture)", async () => {
      const root = await project();
      await mkdir(join(root, ".story", "tickets"), { recursive: true });
      const huge = "y".repeat(8 * 1_048_576);
      await writeFile(join(root, ".story", "tickets", "T-HUGE.json"), huge, "utf8");

      const result = await scanLedgerIntegrity(root);

      expect(result.findings).toContainEqual(expect.objectContaining({
        file: ".story/tickets/T-HUGE.json",
        code: "oversized",
      }));
    });
  });
});
