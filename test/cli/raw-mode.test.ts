/**
 * --raw unwraps ONLY the standard envelope, at the single write seam (ISS-910).
 *
 * The contract under test: {version:1, data} and {version:1, data, warnings}
 * unwrap to data verbatim; {version:1, error} passes through unchanged (an
 * error has no data payload); every other shape -- deviant objects, bare
 * values, non-JSON -- is rejected with an error NAMING the actual shape,
 * never two silently different top-level shapes from one flag.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  checkRawMode,
  configureRawMode,
  transformForRawMode,
  rawRejectionPending,
  resetRawMode,
  RAW_REQUIRES_JSON,
} from "../../src/cli/raw-mode.js";

afterEach(() => {
  resetRawMode();
});

const arm = () => configureRawMode(true, "json");

describe("transformForRawMode", () => {
  it("is the identity when raw mode is not active", () => {
    const text = JSON.stringify({ version: 1, data: { a: 1 } });
    expect(transformForRawMode(text)).toBe(text);
  });

  it("unwraps the standard success envelope to the data payload verbatim", () => {
    arm();
    const out = transformForRawMode(JSON.stringify({ version: 1, data: { tickets: [1, 2] } }, null, 2));
    expect(JSON.parse(out)).toEqual({ tickets: [1, 2] });
    expect(rawRejectionPending()).toBe(false);
  });

  it("unwraps the partial envelope too -- the PARTIAL exit code still signals the warnings", () => {
    arm();
    const out = transformForRawMode(
      JSON.stringify({ version: 1, data: { x: true }, warnings: [{ type: "w" }] }),
    );
    expect(JSON.parse(out)).toEqual({ x: true });
    expect(rawRejectionPending()).toBe(false);
  });

  it("passes the error envelope through unchanged -- there is no data to unwrap", () => {
    arm();
    const text = JSON.stringify({ version: 1, error: { code: "not_found", message: "m" } }, null, 2);
    expect(transformForRawMode(text)).toBe(text);
    expect(rawRejectionPending()).toBe(false);
  });

  it("rejects a deviant object shape, naming its top-level keys", () => {
    arm();
    const out = transformForRawMode(JSON.stringify({ ok: true, data: { limitStops: [] } }));
    const parsed = JSON.parse(out) as { version: number; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("invalid_input");
    expect(parsed.error.message).toContain("top-level keys {ok, data}");
    expect(rawRejectionPending()).toBe(true);
  });

  it("rejects an unknown envelope version rather than guessing at its layout", () => {
    arm();
    const out = transformForRawMode(JSON.stringify({ version: 2, data: {} }));
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe("invalid_input");
    expect(rawRejectionPending()).toBe(true);
  });

  it("rejects non-JSON output and bare JSON values", () => {
    arm();
    expect((JSON.parse(transformForRawMode("# Markdown")) as { error: { message: string } }).error.message)
      .toContain("non-JSON");
    resetRawMode();
    arm();
    expect((JSON.parse(transformForRawMode("[1,2]")) as { error: { message: string } }).error.message)
      .toContain("bare JSON value");
    expect(rawRejectionPending()).toBe(true);
  });
});

describe("checkRawMode -- validation on yargs' native path, never a throw", () => {
  it("rejects --raw without --format json by RETURNING the message", () => {
    // Returning, not throwing: a throw from here prints one envelope and then
    // lets yargs reject the parse with the same error, which the outer catch
    // reports a SECOND time. It also perturbs the pinned handling of a
    // CliValidationError raised inside an async handler (ISS-886 boundary).
    expect(checkRawMode({ raw: true, format: "md" })).toBe(RAW_REQUIRES_JSON);
    expect(checkRawMode({ raw: true, format: undefined })).toBe(RAW_REQUIRES_JSON);
  });

  it("passes every combination that is not the misuse", () => {
    expect(checkRawMode({ raw: true, format: "json" })).toBe(true);
    expect(checkRawMode({ raw: false, format: "md" })).toBe(true);
    expect(checkRawMode({ format: "md" })).toBe(true);
    expect(checkRawMode({})).toBe(true);
  });
});

describe("configureRawMode", () => {
  it("stays inert for a non-json format even if validation is bypassed", () => {
    configureRawMode(true, "md");
    expect(transformForRawMode("# Markdown")).toBe("# Markdown");
    expect(rawRejectionPending()).toBe(false);
  });

  it("stays inactive for commands that never registered --raw", () => {
    configureRawMode(undefined, "json");
    const text = JSON.stringify({ version: 1, data: {} });
    expect(transformForRawMode(text)).toBe(text);
  });

  it("re-arming clears a previous run's rejection latch", () => {
    arm();
    transformForRawMode("not json");
    expect(rawRejectionPending()).toBe(true);
    configureRawMode(false, "md");
    expect(rawRejectionPending()).toBe(false);
  });
});
