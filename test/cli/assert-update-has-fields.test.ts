import { describe, it, expect } from "vitest";
import { assertUpdateHasFields, CliValidationError } from "../../src/cli/helpers.js";

/**
 * ISS-892, no-op half.
 *
 * `storybloq ticket update T-001` with no other flag reported
 * "Updated ticket T-001" at exit 0 while writing a byte-identical file. So did
 * the MCP equivalent, and so did the same call with a misspelled field name,
 * since the unknown key was dropped before the handler ever saw it.
 */

describe("assertUpdateHasFields", () => {
  const call = (updates: Record<string, unknown>) =>
    assertUpdateHasFields(updates, "ticket", "status, title");

  it("rejects an update whose every field is undefined", () => {
    expect(() => call({ status: undefined, title: undefined })).toThrow(CliValidationError);
  });

  it("rejects an update with no fields at all", () => {
    expect(() => call({})).toThrow(CliValidationError);
  });

  it("names the fields, and says a rejected name is the likely cause", () => {
    // The failure this exists for is a caller who DID pass something, under a
    // name the tool does not implement. Saying only "no fields" would leave them
    // re-reading a call that looks correct.
    expect(() => call({})).toThrow(/Supply at least one of: status, title/);
    expect(() => call({})).toThrow(/the name was not recognized/);
  });

  it("reports invalid_input rather than a generic failure", () => {
    try {
      call({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliValidationError);
      expect((err as CliValidationError).code).toBe("invalid_input");
    }
  });

  it("accepts any defined value", () => {
    expect(() => call({ status: "open" })).not.toThrow();
    expect(() => call({ status: undefined, title: "t" })).not.toThrow();
  });

  it("accepts null, which is how a caller clears a field", () => {
    // phase, parentTicket, and resolution are cleared by passing null, so null
    // must count as a real update.
    expect(() => assertUpdateHasFields({ phase: null }, "ticket", "phase")).not.toThrow();
  });

  it("accepts an empty array, which is how a caller empties a list", () => {
    expect(() => assertUpdateHasFields({ blockedBy: [] }, "ticket", "blockedBy")).not.toThrow();
  });

  it("accepts an empty string, which is a real value for a description", () => {
    expect(() => assertUpdateHasFields({ description: "" }, "ticket", "description")).not.toThrow();
  });

  it("accepts 0, which is a real sort order", () => {
    expect(() => assertUpdateHasFields({ order: 0 }, "ticket", "order")).not.toThrow();
  });

  it("does not count a clear-flag left off, which yargs defaults to false", () => {
    // `note update N-001` parses clearTags as false, not undefined. Counting that
    // as a supplied field would let the exact no-op this guard exists for through.
    expect(() => assertUpdateHasFields({ tags: undefined, clearTags: false }, "note", "tags")).toThrow(
      CliValidationError,
    );
  });

  it("counts a clear-flag that was actually set", () => {
    expect(() => assertUpdateHasFields({ tags: undefined, clearTags: true }, "note", "tags")).not.toThrow();
  });
});
