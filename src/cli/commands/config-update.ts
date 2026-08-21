import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { withProjectLock, atomicWrite, guardPath } from "../../core/project-loader.js";
import { ConfigSchema } from "../../models/config.js";
import { ProjectLoaderError } from "../../core/errors.js";
import { deepMergeConfig, assertNoDuplicateKeys, isPlainObject, ConfigMergeError } from "../../core/config-merge.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/**
 * Handle `storybloq config set-overrides`.
 *
 * Merge semantics: keys in --json overwrite existing, keys not provided are preserved.
 * Explicit null removes a key. --clear removes recipeOverrides entirely.
 * Validates merged config with ConfigSchema before writing.
 *
 * `--deep` (T-469) switches the merge from shallow to the contract in
 * `core/config-merge.ts`: objects recurse, null deletes at any depth, arrays and
 * scalars replace. It exists because `recipeOverrides` holds nested settings
 * (`stages.CODE_REVIEW`, `lensConfig`) that a caller edits one leaf at a time,
 * and a shallow merge cannot express "leave this nested sibling alone" -- so
 * writing `stages` from a caller that knows three stage names deleted the rest.
 *
 * It is a separate flag rather than a behaviour change because the shallow
 * merge is the published contract for every existing caller, and because an
 * older CLI REJECTING an unknown `--deep` (yargs runs strict) is what lets a
 * newer client detect the capability instead of silently getting a shallow
 * write. Do not "fix" that by accepting the flag and ignoring it.
 */
export async function handleConfigSetOverrides(
  root: string,
  format: OutputFormat,
  options: { json?: string; clear?: boolean; deep?: boolean },
): Promise<CommandResult> {
  const { json: jsonArg, clear, deep } = options;

  if (deep && !jsonArg) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "--deep requires --json" })
        : "Error: --deep requires --json",
      errorCode: "invalid_input",
    };
  }

  if (!clear && !jsonArg) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "Provide --json or --clear" })
        : "Error: Provide --json or --clear",
      errorCode: "invalid_input",
    };
  }

  // Parse provided JSON
  let parsedOverrides: Record<string, unknown> = {};
  if (jsonArg) {
    try {
      parsedOverrides = JSON.parse(jsonArg) as Record<string, unknown>;
      if (typeof parsedOverrides !== "object" || parsedOverrides === null || Array.isArray(parsedOverrides)) {
        return {
          output: format === "json"
            ? JSON.stringify({ version: 1, error: "Invalid JSON: expected an object" })
            : "Error: Invalid JSON: expected an object",
          errorCode: "invalid_input",
        };
      }
    } catch {
      return {
        output: format === "json"
          ? JSON.stringify({ version: 1, error: "Invalid JSON syntax" })
          : "Error: Invalid JSON syntax",
        errorCode: "invalid_input",
      };
    }
  }

  let resultOverrides: Record<string, unknown> | null = null;

  await withProjectLock(root, { strict: false }, async () => {
    // Read current config as raw JSON (preserves all keys)
    const configPath = join(root, ".story", "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) throw new ProjectLoaderError("io_error", `Cannot read config: ${readResult.error.message}`, readResult.error);
    const raw = JSON.parse(readResult.content) as Record<string, unknown>;

    if (clear) {
      delete raw.recipeOverrides;
    } else {
      const existing = (raw.recipeOverrides ?? {}) as Record<string, unknown>;
      let merged: Record<string, unknown>;

      if (deep) {
        // Duplicate keys are refused on the WRITE path only, and only under
        // --deep, where a nested merge makes them actively dangerous: the Mac
        // app's OrderedJSON reads the FIRST occurrence and JSON.parse keeps the
        // LAST, so merging into such a file would update one while the other
        // stayed authoritative for the other reader. Reads are untouched -- a
        // project with a duplicate must still open, or the user could not see
        // the file we are refusing to save. Checked against the SOURCE TEXT,
        // because `raw` has already collapsed them.
        try {
          assertNoDuplicateKeys(readResult.content, "config.json");
          assertNoDuplicateKeys(jsonArg ?? "{}", "The --json delta");
        } catch (err) {
          // Surface as user error, not io_error: the file is readable and the
          // command is well-formed; the CONTENT is what cannot be merged, and
          // the message already says which key and what to do.
          if (err instanceof ConfigMergeError) {
            throw new ProjectLoaderError("invalid_input", err.message);
          }
          throw err;
        }

        // A non-object container is a config the schema would reject anyway.
        // Refuse rather than replace it: whatever the user actually wrote there
        // is theirs, and clobbering it is not this command's call.
        if (raw.recipeOverrides !== undefined && !isPlainObject(raw.recipeOverrides)) {
          throw new ProjectLoaderError(
            "invalid_input",
            "config.json has a recipeOverrides that is not an object; refusing to merge into it.",
          );
        }
        try {
          merged = deepMergeConfig(existing, parsedOverrides);
        } catch (err) {
          if (err instanceof ConfigMergeError) {
            throw new ProjectLoaderError("invalid_input", err.message);
          }
          throw err;
        }
      } else {
        merged = { ...existing, ...parsedOverrides };
        // Clean: explicit null removes that key (top level only, shallow mode)
        for (const [k, v] of Object.entries(merged)) {
          if (v === null) delete merged[k];
        }
      }

      // Clean: if empty after merge, remove entirely. This one pruning rule is
      // the pre-existing exception to "null removes only its named key"; empty
      // ancestors BELOW the root are left in place.
      if (Object.keys(merged).length === 0) {
        delete raw.recipeOverrides;
      } else {
        raw.recipeOverrides = merged;
      }
    }

    // Validate merged config before writing
    const validated = ConfigSchema.safeParse(raw);
    if (!validated.success) {
      const message = validated.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError(
        "invalid_input",
        `Invalid config after merge: ${message}`,
      );
    }

    // Write atomically
    await guardPath(configPath, root);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");

    resultOverrides = (raw.recipeOverrides as Record<string, unknown>) ?? null;
  });

  const data = { recipeOverrides: resultOverrides };
  if (format === "json") {
    return { output: JSON.stringify({ version: 1, data }, null, 2) };
  }

  if (resultOverrides === null) {
    return { output: "Recipe overrides cleared (using recipe defaults)." };
  }

  const lines = Object.entries(resultOverrides).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
  return { output: `Recipe overrides updated:\n${lines.join("\n")}` };
}

export async function handleConfigSetFederation(
  root: string,
  format: OutputFormat,
  options: { allowNodeWrites?: boolean },
): Promise<CommandResult> {
  if (options.allowNodeWrites === undefined) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "Provide --allow-node-writes or --no-allow-node-writes" })
        : "Error: Provide --allow-node-writes or --no-allow-node-writes",
      errorCode: "invalid_input",
    };
  }

  let resultFederation: Record<string, unknown> | null = null;

  await withProjectLock(root, { strict: false }, async () => {
    const configPath = join(root, ".story", "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) throw new ProjectLoaderError("io_error", `Cannot read config: ${readResult.error.message}`, readResult.error);
    const raw = JSON.parse(readResult.content) as Record<string, unknown>;

    if (raw.type !== "orchestrator") {
      throw new ProjectLoaderError(
        "invalid_input",
        "set-federation is only available on orchestrator projects.",
      );
    }

    const existing = (raw.federation ?? {}) as Record<string, unknown>;
    raw.federation = { ...existing, allowNodeWrites: options.allowNodeWrites };

    const validated = ConfigSchema.safeParse(raw);
    if (!validated.success) {
      const message = validated.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError("invalid_input", `Invalid config after merge: ${message}`);
    }

    await guardPath(configPath, root);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");

    resultFederation = raw.federation as Record<string, unknown>;
  });

  if (format === "json") {
    return { output: JSON.stringify({ version: 1, data: { federation: resultFederation } }, null, 2) };
  }

  return {
    output: `Federation settings updated: allowNodeWrites = ${options.allowNodeWrites}`,
  };
}
