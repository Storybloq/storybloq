import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeConfig, writeRoadmap, loadProject } from "./project-loader.js";
import { ProjectLoaderError, CURRENT_SCHEMA_VERSION, INTEGRITY_WARNING_TYPES } from "./errors.js";
import type { Config } from "../models/config.js";
import type { Roadmap, Phase } from "../models/roadmap.js";

export interface InitOptions {
  name: string;
  force?: boolean;
  type?: string;
  language?: string;
  phases?: Phase[];
}

export interface InitResult {
  readonly root: string;
  readonly created: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Scaffolds a new .story/ directory structure.
 * Refuses if .story/ already exists unless force is true.
 * Force mode overwrites config.json + roadmap.json only — preserves existing data files.
 */
export async function initProject(
  root: string,
  options: InitOptions,
): Promise<InitResult> {
  const absRoot = resolve(root);
  const wrapDir = join(absRoot, ".story");

  // Check if already exists
  let exists = false;
  try {
    const s = await stat(wrapDir);
    if (s.isDirectory()) exists = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProjectLoaderError(
        "io_error",
        `Cannot check .story/ directory: ${(err as Error).message}`,
        err,
      );
    }
  }

  if (exists && !options.force) {
    throw new ProjectLoaderError(
      "conflict",
      ".story/ already exists. Use --force to overwrite config and roadmap.",
    );
  }

  // Create directories
  await mkdir(join(wrapDir, "tickets"), { recursive: true });
  await mkdir(join(wrapDir, "issues"), { recursive: true });
  await mkdir(join(wrapDir, "handovers"), { recursive: true });
  await mkdir(join(wrapDir, "notes"), { recursive: true });
  await mkdir(join(wrapDir, "lessons"), { recursive: true });

  const created: string[] = [
    ".story/config.json",
    ".story/roadmap.json",
    ".story/tickets/",
    ".story/issues/",
    ".story/handovers/",
    ".story/notes/",
    ".story/lessons/",
  ];

  // Today's date
  const today = new Date().toISOString().slice(0, 10);

  const config: Config = {
    version: 2,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: options.name,
    type: options.type ?? "generic",
    language: options.language ?? "unknown",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
  };

  const roadmap: Roadmap = {
    title: options.name,
    date: today,
    phases: options.phases ?? [
      {
        id: "p0",
        label: "PHASE 0",
        name: "Setup",
        description: "Initial project setup.",
      },
    ],
    blockers: [],
  };

  await writeConfig(config, absRoot);
  await writeRoadmap(roadmap, absRoot);

  // Ensure .story/.gitignore covers ephemeral files
  const gitignorePath = join(wrapDir, ".gitignore");
  await ensureGitignoreEntries(gitignorePath, STORY_GITIGNORE_ENTRIES);

  // Validate existing data files when force-reinitializing.
  // Uses loadProject (permissive) — catches both JSON parse errors AND Zod schema
  // violations, matching exactly what strict mode will reject on future writes.
  const warnings: string[] = [];
  if (options.force && exists) {
    try {
      const { warnings: loadWarnings } = await loadProject(absRoot);
      for (const w of loadWarnings) {
        if ((INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type)) {
          warnings.push(`${w.file}: ${w.message}`);
        }
      }
    } catch {
      // loadProject may throw on critical file errors (config/roadmap) —
      // we just wrote those, so this shouldn't happen, but don't let
      // validation failures block init.
    }
  }

  return {
    root: absRoot,
    created,
    warnings,
  };
}

/**
 * Ensures a .gitignore file contains the specified entries.
 * Creates the file if it doesn't exist. Idempotent — skips entries already present.
 */
/** Ephemeral .story/ entries that should always be gitignored. Single source of truth. */
export const STORY_GITIGNORE_ENTRIES = ["snapshots/", "status.json", "sessions/"];

/**
 * Ensures a .gitignore file contains the specified entries.
 * Creates the file if it doesn't exist. Idempotent — skips entries already present.
 */
export async function ensureGitignoreEntries(
  gitignorePath: string,
  entries: string[],
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist — will create
  }

  const lines = existing.split("\n").map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;

  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  await writeFile(gitignorePath, content, "utf-8");
}
