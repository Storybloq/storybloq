/**
 * ISS-1388: the metadata-touch vectors. The Mac app's writer reads the same
 * raw texts from `test/fixtures/metadata-touch-vectors.json` and must stamp
 * `updatedDate` exactly where T-481's `touchUpdated` does, and its parser must
 * accept exactly what `JSON.parse` accepts. The drift test proves the file is
 * the CLI's current output; the spot checks are written out by hand so a
 * generator bug cannot pin itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VECTORS_OUT, buildVectors, serializeVectors } from "../../scripts/metadata-touch-vectors.js";

const vectors = buildVectors();
const stamps = (name: string) => {
  const c = vectors.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  return c.stamps;
};
const accepts = (name: string) => {
  const c = vectors.corpus.find((x) => x.name === name);
  if (!c) throw new Error(`no corpus entry ${name}`);
  return c.accepts;
};

describe("metadata-touch vectors", () => {
  it("the checked-in file is current", () => {
    expect(readFileSync(VECTORS_OUT, "utf-8")).toBe(serializeVectors());
  });

  it("non-content keys, the displayId fill and key order never stamp", () => {
    for (const n of ["updatedDate only", "earmark only", "sweepAcquisition only", "displayId null vs filled", "top-level key order", "nested key order"]) {
      expect(stamps(n), n).toBe(false);
    }
  });

  it("content changes stamp, and a create never does", () => {
    for (const n of ["title change", "status change", "earmark plus claim change", "null vs absent content key", "unknown passthrough key added"]) {
      expect(stamps(n), n).toBe(true);
    }
    expect(stamps("create")).toBe(false);
  });

  it("JSON.parse number semantics: 1 is 1.0 but not true, and non-finite numbers are null", () => {
    expect(stamps("1 vs 1.0")).toBe(false);
    expect(stamps("1 vs true")).toBe(true);
    expect(stamps("2^53+1 vs 2^53")).toBe(false);
    expect(stamps("overflow vs null")).toBe(false);
    expect(stamps("overflow vs 1")).toBe(true);
  });

  it("an own __proto__ key is content, at the top level and nested", () => {
    for (const n of ["__proto__ added", "__proto__ changed", "nested __proto__ added", "nested __proto__ changed"]) {
      expect(stamps(n), n).toBe(true);
    }
    for (const n of ["__proto__ unchanged", "nested __proto__ unchanged"]) {
      expect(stamps(n), n).toBe(false);
    }
  });

  it("NFC and NFD keys in one object stay two keys", () => {
    expect(stamps("both forms, NFC value changed")).toBe(true);
    expect(stamps("both forms, NFD value changed")).toBe(true);
    expect(stamps("both forms, order swapped")).toBe(false);
  });

  it("the corpus records JSON.parse's verdict", () => {
    expect(accepts("number 01")).toBe(false);
    expect(accepts("trailing comma in object")).toBe(false);
    expect(accepts("leading BOM")).toBe(false);
    expect(accepts("overflowing number")).toBe(true);
  });
});
