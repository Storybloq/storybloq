import { readHandover } from "../../core/handover-parser.js";
import { buildHandoverBrief, isFilenameAdmitted } from "../../core/handover-brief.js";
import {
  HANDOVER_TEMPLATE_MARKER,
  computeCarriedForward,
  parseCarriedForwardSection,
  parseOverrideBody,
  renderHandoverTemplate,
  type CarriedForwardEntry,
  type OverrideLine,
} from "../../core/handover-template.js";
import type { TrajectoryEntry } from "../../core/markdown-sections.js";
import { existsSync } from "node:fs";
import { recordBoardTarget } from "../../core/board-write-recorder.js";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatHandoverList,
  formatHandoverContent,
  formatHandoverBrief,
  formatHandoverTemplate,
  formatHandoverCreateResult,
  formatError,
  ExitCode,
  type HandoverStampFailure,
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

export interface HandoverLatestOptions {
  readonly brief?: boolean;
  readonly priming?: boolean;
}

export async function handleHandoverLatest(
  ctx: CommandContext,
  count: number = 1,
  opts: HandoverLatestOptions = {},
): Promise<CommandResult> {
  if (ctx.state.handoverFilenames.length === 0) {
    return {
      output: formatError("not_found", "No handovers found", ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  const filenames = ctx.state.handoverFilenames.slice(0, count);

  // T-320 commit 2: brief/priming are additive -- omitting both keeps the
  // default path below byte-identical to today (always the full raw body).
  if (opts.brief || opts.priming) {
    // T-320: the admission gate runs BEFORE any filesystem validation -- an
    // oversized filename must be skippable (and counted) without ever
    // reaching parseHandoverFilename's lstat, which throws on a symlink and
    // would otherwise fail the whole request instead of just dropping it.
    for (const filename of filenames) {
      if (isFilenameAdmitted(filename)) {
        await parseHandoverFilename(filename, ctx.handoversDir);
      }
    }
    try {
      const result = await buildHandoverBrief(ctx.handoversDir, filenames, {
        brief: opts.brief ?? false,
        priming: opts.priming ?? false,
      });
      // buildHandoverBrief drops a listed-but-missing file (ENOENT) from the
      // window itself rather than failing the whole request -- matching the
      // default path's own tolerance for a missing file when count > 1.
      // not_found applies only when NOTHING is left to report: an empty
      // window AND no admission skips. If every filename was instead
      // rejected for an oversized name (skippedHandovers > 0), that is a
      // real, observable result (the files exist) and must render through
      // formatHandoverBrief's own skipped-count message, not collapse into
      // a misleading "not found".
      if (result.handovers.length === 0 && result.skippedHandovers === 0) {
        return {
          output: formatError("not_found", "No handovers found", ctx.format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        };
      }
      return { output: formatHandoverBrief(result, ctx.format) };
    } catch (err: unknown) {
      return {
        output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
      };
    }
  }

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

export interface HandoverTemplateOptions {
  /** Body of an `Override:` line, without the `Override: ` prefix (e.g. "recommended=T-1 worked=T-2 because=owner said so"). */
  readonly override?: string;
}

/**
 * T-498 Commit 1: scaffolds a new handover document -- category headings, a
 * `Carried forward` section derived from the standing `count:10 brief:true`
 * trajectory (with the earlier-of-two-dates preservation rule against
 * whatever the CURRENT newest handover already recorded), an optional
 * validated `Override:` line, and the `<!-- storybloq-handover v1 -->`
 * marker. Read-only: never writes a file (pipe the output into `handover
 * create --stdin` to actually save it).
 */
export async function handleHandoverTemplate(
  ctx: CommandContext,
  opts: HandoverTemplateOptions = {},
): Promise<CommandResult> {
  let override: OverrideLine | null = null;
  if (opts.override !== undefined) {
    override = parseOverrideBody(opts.override);
    if (override === null) {
      throw new CliValidationError(
        "invalid_input",
        "Invalid --override grammar. Expected: recommended=<id> worked=<id> because=<text>",
      );
    }
  }

  const filenames = ctx.state.handoverFilenames;
  let previousCarried: CarriedForwardEntry[] = [];
  let trajectory: readonly TrajectoryEntry[] = [];
  const currentLabels = new Map<string, string>();

  if (filenames.length > 0) {
    const newest = filenames[0] as string;
    // Same admission + symlink/traversal rejection every other handover read
    // path runs before touching the file -- an oversized name is skipped
    // (matching the brief/priming tolerance), but a rejected name (path
    // traversal, symlink) throws and is NOT silently treated as "no prior
    // carried state."
    if (isFilenameAdmitted(newest)) {
      await parseHandoverFilename(newest, ctx.handoversDir);
      try {
        const raw = await readHandover(ctx.handoversDir, newest);
        if (raw.includes(HANDOVER_TEMPLATE_MARKER)) {
          previousCarried = parseCarriedForwardSection(raw);
        }
      } catch (err: unknown) {
        // ENOENT (listed but deleted since the state scan) is the one
        // tolerated case -- proceed with no prior carried state, same as a
        // brand-new project. Anything else (permission error, etc.) is a
        // real I/O failure and must not be reported as a successful,
        // silently-empty scaffold.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    const windowFilenames = filenames.slice(0, 10);
    for (const filename of windowFilenames) {
      if (isFilenameAdmitted(filename)) {
        await parseHandoverFilename(filename, ctx.handoversDir);
      }
    }
    // No blanket catch here: buildHandoverBrief already tolerates a missing
    // (ENOENT) window entry internally (see handleHandoverLatest's brief
    // path) -- any error it does throw is a real failure and must propagate
    // as io_error, not collapse into a falsely-successful empty scaffold.
    const result = await buildHandoverBrief(ctx.handoversDir, windowFilenames, {
      brief: true,
      priming: false,
    });
    trajectory = result.trajectory;
    const first = result.handovers[0];
    if (first && first.form === "structured") {
      for (const record of first.records) {
        if (record.id) currentLabels.set(record.id, record.label);
      }
    }
  }

  const carriedForward = computeCarriedForward(trajectory, previousCarried, currentLabels);
  const content = renderHandoverTemplate({ carriedForward, override });
  return { output: formatHandoverTemplate(content, ctx.format) };
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
  /** T-499: the caller's identity for the handover stamp; `stamp: false` skips it (tests, batch tooling). */
  intel: {
    readonly clientTaskId?: string | null;
    readonly stamp?: boolean;
    readonly now?: number;
    readonly projectsDir?: string;
    /**
     * ISS-1214: which surface is asking. It decides which skips are worth
     * reporting (a terminal is never a Claude session; an MCP caller always
     * should be) and whether a server-staleness claim can be made at all.
     */
    readonly surface?: "mcp" | "cli";
  } = {},
): Promise<CommandResult> {
  if (!content.trim()) {
    throw new CliValidationError("invalid_input", "Handover content is empty");
  }

  const slug = normalizeSlug(slugRaw);
  const date = todayISO();
  let filename: string | undefined;
  const absRoot = resolve(root);

  await withProjectLock(root, { strict: false }, async () => {
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
          recordBoardTarget(candidatePath, "write");
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

  // T-499: the handover is on disk; record it against the caller's current
  // compaction boundary so imperative pressure is held at advisory until the
  // context grows by a step or the next compaction. Best-effort, after the
  // project lock is released, never affecting the result.
  let stamped = false;
  let stampedRoot: string | null = null;
  // ISS-1197 commit 2: past the compact line the stamp still lands, but it
  // suppresses nothing, so the reply must not claim it did.
  let compactNeeded = false;
  // ISS-1214: why an attempted stamp did not land, so the reply cannot read
  // as success while the record keeps `handoverWrittenAt: null` and the
  // prompt hook re-fires the imperative with no visible cause.
  let stampFailure: HandoverStampFailure | null = null;
  let serverStale = false;
  // ISS-1263: how the stamp bound, and the re-arm interval the reply quotes.
  let stampBinding: "bound" | "unbound-era" = "bound";
  let rearmIntervalMs = 600_000;
  if (intel.stamp !== false) {
    try {
      const { describeStampFailure, stampHandoverForCaller } = await import("../../core/session-intel/push.js");
      const { readSessionIntelConfig } = await import("../../core/session-intel/config.js");
      rearmIntervalMs = readSessionIntelConfig(root).handoverRearmIntervalMs;
      const r = stampHandoverForCaller(root, { explicitTaskId: intel.clientTaskId, cwd: root, now: intel.now, projectsDir: intel.projectsDir });
      // Only a stamp whose locked write LANDED counts: a busy lock, a failed
      // write, or a refusal under the lock leaves the record unchanged.
      stamped = r.status === "stamped" && r.outcome.status === "written";
      if (stamped && r.status === "stamped") {
        stampedRoot = r.root;
        compactNeeded = r.pressureState === "compact-needed";
        stampBinding = r.binding;
      } else {
        stampFailure = describeStampFailure(r, intel.surface ?? "cli");
      }
    } catch (err) {
      // Reached only if the import or the stamp itself throws. Silent before
      // ISS-1214, which is the exact shape that hid the field-report failure.
      stampFailure = { reason: `error: ${err instanceof Error ? err.message : String(err)}`, kind: "error" };
    }
    // Only the MCP surface can answer this: the staleness question is about a
    // long-lived server process against the build on disk, and a CLI process
    // was just spawned from that build. Asked only when there is a failure to
    // explain, so the ordinary path does not pay for it.
    if (stampFailure !== null && intel.surface === "mcp") {
      try {
        const { describeBinaryStaleness } = await import("../../autonomous/binary-staleness.js");
        serverStale = describeBinaryStaleness() !== null;
      } catch {
        serverStale = false;
      }
    }
  }

  // The continuation line rides only on a landed stamp: an unbound caller
  // (or a stamp that missed) gets the bare result, so the line never claims
  // a suppression that did not happen. ISS-1185: stampedRoot is reported
  // only when it diverges from the MCP root (formatHandoverCreateResult
  // gates on that itself).
  return { output: formatHandoverCreateResult(filename!, format, stamped, stampedRoot, absRoot, compactNeeded, stampFailure, serverStale, stampBinding, rearmIntervalMs) };
}
