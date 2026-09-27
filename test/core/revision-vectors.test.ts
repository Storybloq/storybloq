/**
 * T-528: the ledger revision vectors the Mac app pins
 * (`ClaudeStoryModels/Tests/ClaudeStoryModelsTests/LedgerRevisionTests.swift`)
 * are the CLI's own output. Regenerate with `npx tsx scripts/revision-vectors.ts`.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serializeVectors, buildVectors, VECTORS_OUT } from "../../scripts/revision-vectors.js";
import { LEDGER_REVISION_HEADER } from "../../src/core/decisions-projection.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("revision vectors", () => {
  it("the checked-in file equals the CLI's output", () => {
    expect(readFileSync(VECTORS_OUT, "utf-8")).toBe(serializeVectors());
  });

  const byName = new Map(buildVectors().map((v) => [v.name, v]));
  const rev = (name: string) => byName.get(name)!.revision;

  it("an empty ledger is the header and three absent singleton lines", () => {
    expect(rev("empty-ledger")).toBe(sha(`${LEDGER_REVISION_HEADER}capabilities.json\t-\nconfig.json\t-\nglossary.json\t-\n`));
  });

  it("absent, empty and enveloped catalogs are three different revisions", () => {
    expect(new Set([rev("base"), rev("empty-catalogs"), rev("catalogs")]).size).toBe(3);
  });

  it("an added, a deleted and a one-byte-edited ticket each move the revision", () => {
    for (const name of ["ticket-added", "ticket-deleted", "one-byte-edit"]) expect(rev(name)).not.toBe(rev("base"));
  });

  it("files outside the input set leave the revision alone", () => {
    expect(rev("non-json-ignored")).toBe(rev("base"));
  });

  it("an NFD file name is recorded in NFC", () => {
    const paths = byName.get("nfd-name")!.entries.map((e) => e.path);
    expect(paths).toContain("rulings/Café.json");
    expect(paths).not.toContain("rulings/Café.json");
  });

  it("lines sort by UTF-8 bytes, not UTF-16 code units: U+E000 before U+10000", () => {
    const v = byName.get("utf8-order")!;
    const line = (e: (typeof v.entries)[number]) => `${e.path}\t${e.state.kind === "ok" ? e.state.sha256 : "-"}\n`;
    const lines = v.entries.map(line);
    const byBytes = [...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const byUnits = [...lines].sort();
    expect(byBytes.filter((l) => l.startsWith("rulings/"))).toEqual([
      expect.stringMatching(/^rulings\/\.json\t/), expect.stringMatching(/^rulings\/r-1111111111111111\.json\t/),
      expect.stringMatching(/^rulings\/\uE000\.json\t/), expect.stringMatching(/^rulings\/\u{10000}\.json\t/u),
    ]);
    expect(byUnits).not.toEqual(byBytes);
    expect(v.revision).toBe(sha(LEDGER_REVISION_HEADER + byBytes.join("")));
    expect(v.revision).not.toBe(sha(LEDGER_REVISION_HEADER + byUnits.join("")));
  });

  it("an unreadable entry makes the revision null", () => {
    expect(rev("unreadable-entry")).toBeNull();
    expect(byName.get("unreadable-entry")!.entries.find((e) => e.path === "tickets/T-5.json")?.state.kind).toBe("unreadable");
  });
});
