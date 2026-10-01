import { basename, join } from "node:path";
import type { Argv } from "yargs";
import { initProject } from "../../core/init.js";
import { ProjectLoaderError } from "../../core/errors.js";
import { ExitCode, formatInitResult, formatError } from "../../core/output-formatter.js";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { resolveNodePath } from "../../federation/resolver.js";
import { addFormatOption, parseOutputFormat, CliValidationError } from "../helpers.js";
import { tryReadFile } from "../util/file-io.js";
import { writeOutput } from "../run.js";

export function registerInitCommand(yargs: Argv): Argv {
  return yargs.command(
    "init",
    "Scaffold a new .story/ project",
    (y) =>
      addFormatOption(
        y
          .option("name", {
            type: "string",
            describe: "Project name (defaults to current directory name)",
          })
          .option("force", {
            type: "boolean",
            default: false,
            describe: "Overwrite existing config and roadmap",
          })
          .option("type", {
            type: "string",
            describe: "Project type (e.g. npm, macapp)",
          })
          .option("language", {
            type: "string",
            describe: "Primary language",
          })
          .option("node", {
            type: "string",
            describe: "Init a federation child node by name (orchestrator only)",
          }),
      ),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const nodeName = argv.node as string | undefined;

      if (nodeName) {
        await handleNodeInit(nodeName, argv, format);
        return;
      }

      try {
        const name = (argv.name as string | undefined) ?? basename(process.cwd());
        if (!name) {
          throw new CliValidationError(
            "invalid_input",
            "Could not derive project name from current directory. Use --name to specify.",
          );
        }

        const parentRoot = discoverProjectRoot();
        if (parentRoot && parentRoot !== process.cwd()) {
          process.stderr.write(
            `Warning: existing .story/ project found at ${parentRoot}. Creating nested project.\n`,
          );
        }

        const result = await initProject(process.cwd(), {
          name,
          force: argv.force,
          type: argv.type as string | undefined,
          language: argv.language as string | undefined,
        });
        writeOutput(formatInitResult(result, format), format);
        process.exitCode = ExitCode.OK;
      } catch (err: unknown) {
        if (err instanceof ProjectLoaderError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        if (err instanceof CliValidationError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, format), format);
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

async function handleNodeInit(
  nodeName: string,
  argv: { name?: unknown; force?: unknown; type?: unknown; language?: unknown },
  format: "md" | "json",
): Promise<void> {
  try {
    const orchRoot = discoverProjectRoot();
    if (!orchRoot) {
      writeOutput(formatError("not_found", "No .story/ project found. Run from an orchestrator project.", format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const configResult = tryReadFile(join(orchRoot, ".story", "config.json"));
    if (!configResult.ok) {
      writeOutput(formatError("io_error", "Cannot read orchestrator config.", format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    let config: Record<string, unknown>;
    try { config = JSON.parse(configResult.content) as Record<string, unknown>; } catch {
      writeOutput(formatError("validation_failed", "Orchestrator config.json is not valid JSON.", format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    if (config.type !== "orchestrator") {
      writeOutput(formatError("not_orchestrator", "--node is only available on orchestrator projects.", format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const rawNodes = config.nodes;
    if (!rawNodes || typeof rawNodes !== "object" || Array.isArray(rawNodes) || !(nodeName in (rawNodes as Record<string, unknown>))) {
      writeOutput(formatError("node_not_found", `Node "${nodeName}" not found in orchestrator config.`, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const nodeConf = (rawNodes as Record<string, Record<string, unknown>>)[nodeName]!;
    const rawPath = typeof nodeConf.path === "string" ? nodeConf.path : "";
    if (!rawPath) {
      writeOutput(formatError("node_not_found", `Node "${nodeName}" has no path configured.`, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const resolved = resolveNodePath(rawPath, orchRoot);
    let targetPath: string;
    if (resolved.resolved) {
      if (!(argv.force as boolean | undefined)) {
        writeOutput(formatError("already_exists", `Node "${nodeName}" already has .story/. Use --force to reinitialize.`, format), format);
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      targetPath = resolved.absolutePath;
    } else if (resolved.reason === "no .story/config.json found" && resolved.absolutePath) {
      targetPath = resolved.absolutePath;
    } else {
      writeOutput(formatError("io_error", `Cannot resolve path for node "${nodeName}": ${resolved.reason}`, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const name = (argv.name as string | undefined) ?? nodeName;
    const result = await initProject(targetPath, {
      name,
      force: argv.force as boolean | undefined,
      type: (argv.type as string | undefined) ?? (typeof nodeConf.stack === "string" ? nodeConf.stack : undefined),
      language: argv.language as string | undefined,
    });

    writeOutput(formatInitResult(result, format), format);
    process.exitCode = ExitCode.OK;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}
