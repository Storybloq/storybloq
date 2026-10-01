/**
 * ISS-1281: writeOutput is the one seam every CLI command prints through, so
 * it is where Markdown output loses its terminal controls. The caller states
 * the format it wrote; JSON is never touched, and --raw (JSON only) still
 * sees the original bytes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { outputFormatOf, writeOutput } from "../../src/cli/run.js";
import { configureRawMode, resetRawMode } from "../../src/cli/raw-mode.js";

const HOSTILE = "Plain \u001b[31mRED\u001b[0m \u001b]0;pwned\u0007 \u009b2J \u202e \u2028 end";

describe("writeOutput sanitizes by the format the caller states (ISS-1281)", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    resetRawMode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRawMode();
  });

  it("W1: md is sanitized, json is written byte for byte", () => {
    writeOutput(`# ${HOSTILE}\n\nline two\ttabbed`, "md");
    expect(written).toEqual(["# Plain ?[31mRED?[0m ?]0;pwned? ?2J ? ? end\n\nline two\ttabbed\n"]);

    written = [];
    const json = JSON.stringify({ version: 1, data: { title: HOSTILE } }, null, 2);
    writeOutput(json, "json");
    expect(written).toEqual([json + "\n"]);
  });

  it("W2: under --raw the envelope is unwrapped from the original bytes and left unsanitized", () => {
    configureRawMode(true, "json");
    writeOutput(JSON.stringify({ version: 1, data: { title: HOSTILE } }, null, 2), "json");
    expect(written).toEqual([JSON.stringify({ title: HOSTILE }, null, 2) + "\n"]);
    expect(JSON.parse(written[0]!).title).toBe(HOSTILE);

    written = [];
    writeOutput(`prose, not JSON ${HOSTILE}`, "json");
    const envelope = JSON.parse(written[0]!) as { version: number; error: { code: string } };
    expect(envelope.error.code).toBe("invalid_input");
    expect(written).toEqual([JSON.stringify(envelope, null, 2) + "\n"]);
  });

  it("W3: outputFormatOf names json exactly when the option says json, as noProjectFoundOutput does", () => {
    expect(outputFormatOf("json")).toBe("json");
    for (const raw of ["md", undefined, null, "JSON", "guide-report", 1]) expect(outputFormatOf(raw), String(raw)).toBe("md");
  });
});
