import { readHandover } from "../../core/handover-parser.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatHandoverList,
  formatHandoverContent,
  formatHandoverCreateResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  withProjectLock,
  atomicWrite,
  fencedLink,
  guardPath,
  detectTeamModeFromDisk,
} from "../../core/project-loader.js";
import { parseHandoverFilename, todayISO, CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

export function handleHandoverList(ctx: CommandContext): CommandResult {
  return { output: formatHandoverList(ctx.state.handoverFilenames, ctx.format) };
}

export async function handleHandoverLatest(
  ctx: CommandContext,
  count: number = 1,
): Promise<CommandResult> {
  if (ctx.state.handoverFilenames.length === 0) {
    return {
      output: formatError("not_found", "No handovers found", ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  const filenames = ctx.state.handoverFilenames.slice(0, count);
  const parts: string[] = [];

  for (const filename of filenames) {
    await parseHandoverFilename(filename, ctx.handoversDir);
    try {
      const content = await readHandover(ctx.handoversDir, filename);
      parts.push(formatHandoverContent(filename, content, ctx.format));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Skip missing files silently when loading multiple
        if (count > 1) continue;
        return {
          output: formatError("not_found", `Handover file not found: ${filename}`, ctx.format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        };
      }
      return {
        output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
      };
    }
  }

  if (parts.length === 0) {
    return {
      output: formatError("not_found", "No handovers found", ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  const separator = ctx.format === "json" ? "\n" : "\n\n---\n\n";
  return { output: parts.join(separator) };
}

export async function handleHandoverGet(
  filename: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  await parseHandoverFilename(filename, ctx.handoversDir);

  try {
    const content = await readHandover(ctx.handoversDir, filename);
    return { output: formatHandoverContent(filename, content, ctx.format) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        output: formatError("not_found", `Handover not found: ${filename}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "not_found",
      };
    }
    return {
      output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "io_error",
    };
  }
}

// --- Create ---

/**
 * Normalizes a slug for handover filenames.
 * Trim, lowercase, whitespace→hyphen, strip non [a-z0-9-], max 60 chars.
 */
export function normalizeSlug(raw: string): string {
  let slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-$/, "");
  if (!slug) {
    throw new CliValidationError(
      "invalid_input",
      `Slug is empty after normalization: "${raw}"`,
    );
  }
  return slug;
}

// ISS-701: delegate config reading to the single shared detector
// (detectTeamModeFromDisk) and apply handover's own degradation policy on top:
// a missing config means a non-team project (use sequential filenames), but a
// malformed/unreadable config is a real error and propagates.
async function detectTeamMode(absRoot: string): Promise<boolean> {
  try {
    return await detectTeamModeFromDisk(absRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Creates a handover markdown file.
 * Runs inside withProjectLock for atomic filename allocation + write.
 */
export async function handleHandoverCreate(
  content: string,
  slugRaw: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (!content.trim()) {
    throw new CliValidationError("invalid_input", "Handover content is empty");
  }

  const slug = normalizeSlug(slugRaw);
  const date = todayISO();
  let filename: string | undefined;

  await withProjectLock(root, { strict: false }, async () => {
    const absRoot = resolve(root);
    const handoversDir = join(absRoot, ".story", "handovers");
    await mkdir(handoversDir, { recursive: true });
    const wrapDir = join(absRoot, ".story");

    const isTeamMode = await detectTeamMode(absRoot);

    if (isTeamMode) {
      const { generateTeamHandoverFilename } = await import("../../core/handover-filename.js");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { randomBytes } = await import("node:crypto");
      let attempt = 0;
      while (attempt < 5) {
        const candidate = generateTeamHandoverFilename(slug);
        const candidatePath = join(handoversDir, candidate);
        const tmpPath = join(handoversDir, `.tmp-${randomBytes(4).toString("hex")}`);
        let tmpCreated = false;
        try {
          await parseHandoverFilename(candidate, handoversDir);
          await guardPath(candidatePath, wrapDir);
          writeFileSync(tmpPath, content, "utf-8");
          tmpCreated = true;
          await fencedLink(tmpPath, candidatePath);
          filename = candidate;
          try { unlinkSync(tmpPath); } catch {}
          tmpCreated = false;
          break;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            attempt++;
            continue;
          }
          throw err;
        } finally {
          if (tmpCreated) {
            try { unlinkSync(tmpPath); } catch {}
          }
        }
      }
      if (!filename) {
        throw new CliValidationError("conflict", "Failed to create unique handover filename after 5 retries");
      }
    } else {
      const seqRegex = new RegExp(`^${date}-(\\d{2})-`);
      let maxSeq = 0;

      const { readdirSync } = await import("node:fs");
      try {
        for (const f of readdirSync(handoversDir)) {
          const m = f.match(seqRegex);
          if (m) {
            const n = parseInt(m[1]!, 10);
            if (n > maxSeq) maxSeq = n;
          }
        }
      } catch {
        // dir empty or unreadable
      }

      let nextSeq = maxSeq + 1;
      if (nextSeq > 99) {
        throw new CliValidationError("conflict", `Too many handovers for ${date}; limit is 99 per day`);
      }

      let candidate = `${date}-${String(nextSeq).padStart(2, "0")}-${slug}.md`;
      let candidatePath = join(handoversDir, candidate);

      while (existsSync(candidatePath)) {
        nextSeq++;
        if (nextSeq > 99) {
          throw new CliValidationError("conflict", `Too many handovers for ${date}; limit is 99 per day`);
        }
        candidate = `${date}-${String(nextSeq).padStart(2, "0")}-${slug}.md`;
        candidatePath = join(handoversDir, candidate);
      }

      await parseHandoverFilename(candidate, handoversDir);
      await guardPath(candidatePath, wrapDir);
      await atomicWrite(candidatePath, content);
      filename = candidate;
    }
  });

  return { output: formatHandoverCreateResult(filename!, format) };
}
