import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { runReadCommand, runReadCommandWithRoot, runDeleteCommand, writeOutput } from "../../src/cli/run.js";
import { ExitCode } from "../../src/core/output-formatter.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { CliValidationError } from "../../src/cli/helpers.js";
import { RefResolutionError } from "../../src/core/ref-normalization.js";

describe("writeOutput", () => {
  it("writes to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeOutput("hello");
    expect(spy).toHaveBeenCalledWith("hello\n");
    spy.mockRestore();
  });
});

describe("runReadCommand", () => {
  const tmpDirs: string[] = [];
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    process.exitCode = undefined;
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("discovers root and calls handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", (ctx) => ({
      output: `project: ${ctx.state.config.project}`,
    }));
    expect(spy).toHaveBeenCalled();
    const output = (spy.mock.calls[0]![0] as string);
    expect(output).toContain("project: test");
    expect(process.exitCode).toBe(ExitCode.OK);
    spy.mockRestore();
  });

  it("returns USER_ERROR when no project found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", () => ({ output: "should not reach" }));
    const output = (spy.mock.calls[0]![0] as string);
    expect(output).toContain("not_found");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("catches ProjectLoaderError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", () => {
      throw new ProjectLoaderError("project_corrupt", "bad data");
    });
    const output = (spy.mock.calls[0]![0] as string);
    expect(output).toContain("project_corrupt");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("catches CliValidationError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", () => {
      throw new CliValidationError("invalid_input", "bad arg");
    });
    const output = (spy.mock.calls[0]![0] as string);
    expect(output).toContain("invalid_input");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("catches unknown errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", () => {
      throw new Error("unexpected");
    });
    const output = (spy.mock.calls[0]![0] as string);
    expect(output).toContain("io_error");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("returns OK when no warnings present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("md", (_ctx) => ({
      output: "ok",
    }));
    expect(process.exitCode).toBe(ExitCode.OK);
    spy.mockRestore();
  });

  // ISS-805: an ambiguous ref is caller input, not a project conflict, so all
  // three pipelines must map RefResolutionError("ambiguous") to invalid_input,
  // not conflict. Missing refs stay not_found.
  it("maps ambiguous RefResolutionError to invalid_input (runReadCommand)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("json", () => {
      throw new RefResolutionError("ambiguous", 'Ref "T-9" is ambiguous (matches: a, b)');
    });
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("invalid_input");
    expect(output).not.toContain("conflict");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("maps ambiguous RefResolutionError to invalid_input (runReadCommandWithRoot)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommandWithRoot("json", dir, () => {
      throw new RefResolutionError("ambiguous", 'Ref "N-9" is ambiguous (matches: a, b)');
    });
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("invalid_input");
    expect(output).not.toContain("conflict");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("maps ambiguous RefResolutionError to invalid_input (runDeleteCommand)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDeleteCommand("json", true, () => {
      throw new RefResolutionError("ambiguous", 'Ref "L-9" is ambiguous (matches: a, b)');
    });
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("invalid_input");
    expect(output).not.toContain("conflict");
    expect(process.exitCode).toBe(ExitCode.USER_ERROR);
    spy.mockRestore();
  });

  it("keeps missing RefResolutionError as not_found (runReadCommand)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    process.chdir(dir);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runReadCommand("json", () => {
      throw new RefResolutionError("missing", 'Ref "T-9" not found');
    });
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("not_found");
    spy.mockRestore();
  });

  describe("T-476 ruling #9: CommandResult.warnings upgrades OK to PARTIAL, never overrides a real error", () => {
    it("upgrades an OK result to PARTIAL when the handler returns warnings", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("md", () => ({ output: "ok", warnings: ["ruling r-x is unreadable"] }));
      expect(process.exitCode).toBe(ExitCode.PARTIAL);
      spy.mockRestore();
    });

    it("prints the warning text in markdown mode, not just the exit code", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("md", () => ({ output: "ok", warnings: ["ruling r-x is unreadable"] }));
      const printed = spy.mock.calls.map((c) => c[0]).join("");
      expect(printed).toContain("ok");
      expect(printed).toContain("Warning: ruling r-x is unreadable");
      spy.mockRestore();
    });

    it("injects warnings as a top-level sibling of the standard {version, data} JSON envelope (the shape raw-mode.ts already documents and tests)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("json", () => ({
        output: JSON.stringify({ version: 1, data: { id: "r-1" } }),
        warnings: ["rulings/broken.json: invalid JSON"],
      }));
      const printed = spy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(printed);
      expect(parsed).toEqual({
        version: 1,
        data: { id: "r-1" },
        warnings: ["rulings/broken.json: invalid JSON"],
      });
      spy.mockRestore();
    });

    it("leaves a JSON error envelope untouched even if warnings were somehow present", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("json", () => ({
        output: JSON.stringify({ version: 1, error: { code: "not_found", message: "x" } }),
        exitCode: ExitCode.USER_ERROR,
        warnings: ["should not be injected"],
      }));
      const printed = spy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(printed);
      expect(parsed).toEqual({ version: 1, error: { code: "not_found", message: "x" } });
      spy.mockRestore();
    });

    it("does not touch exit code when warnings is an empty array", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("md", () => ({ output: "ok", warnings: [] }));
      expect(process.exitCode).toBe(ExitCode.OK);
      spy.mockRestore();
    });

    it("never overrides a handler's own non-OK exitCode with a PARTIAL upgrade", async () => {
      const dir = await mkdtemp(join(tmpdir(), "run-test-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      process.chdir(dir);

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runReadCommand("md", () => ({
        output: "not found",
        exitCode: ExitCode.USER_ERROR,
        warnings: ["ruling r-x is unreadable"],
      }));
      expect(process.exitCode).toBe(ExitCode.USER_ERROR);
      spy.mockRestore();
    });
  });
});
